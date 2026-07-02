#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_backup.db"

echo "🔧 Применение шаблона базы данных..."

# 1. Делаем бэкап текущей базы
echo "💾 Делаю бэкап текущей базы..."
sudo cp "$DB_PATH" "$BACKUP"
sudo chmod 666 "$BACKUP"

# 2. Функция для SQL
run_sql_backup() {
    docker run --rm -v /tmp:/tmp alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /tmp/noco_backup.db "'"$1"'"
    '
}

# 3. Получаем данные из бэкапа
WORKSPACE_ID=$(run_sql_backup "SELECT id FROM nc_org LIMIT 1;")
USER_ID=$(run_sql_backup "SELECT id FROM nc_users_v2 LIMIT 1;")

if [ -z "$WORKSPACE_ID" ] || [ -z "$USER_ID" ]; then
    echo "❌ Workspace или пользователь не найдены в бэкапе"
    echo "   Workspace: '$WORKSPACE_ID'"
    echo "   User: '$USER_ID'"
    echo ""
    echo "💡 Подсказка: ты создал новую базу в NocoDB?"
    echo "   Workspace создаётся только при создании базы."
    exit 1
fi
echo "   Workspace: $WORKSPACE_ID"
echo "   User: $USER_ID"

# 4. Копируем template.db как рабочую базу
echo "📦 Копирую template.db..."
sudo rm -f "$DB_PATH"
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

# 5. Создаём SQL для обновления
SQL_FILE="/tmp/patch.sql"
cat > "$SQL_FILE" <<EOF
ATTACH DATABASE '/tmp/noco_backup.db' AS backup;

-- Очищаем пользователей из template
DELETE FROM nc_users_v2;
DELETE FROM nc_org_users;
DELETE FROM nc_base_users_v2;
DELETE FROM nc_user_refresh_tokens;
DELETE FROM nc_api_tokens;

-- Копируем пользователя из бэкапа (сохраняем хеш пароля!)
INSERT INTO nc_users_v2 SELECT * FROM backup.nc_users_v2;

-- Копируем refresh tokens
INSERT INTO nc_user_refresh_tokens SELECT * FROM backup.nc_user_refresh_tokens;

-- Создаём workspace с ТЕМ ЖЕ ID, что из бэкапа
INSERT INTO nc_org (id, title, meta, created_at, updated_at)
SELECT id, title, meta, created_at, updated_at FROM backup.nc_org;

-- Копируем секретные ключи
DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM backup.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');

-- Устанавливаем NC_DEFAULT_WORKSPACE_ID
INSERT INTO nc_store (type, key, value, created_at, updated_at)
VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));

-- Обновляем workspace_id в базах и источниках
UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID';
UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID';

-- Привязки пользователя к workspace и базе
INSERT INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at)
VALUES ('$WORKSPACE_ID', '$USER_ID', '["org.owner"]', datetime('now'), datetime('now'));

INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
SELECT b.id, '$USER_ID', '["owner"]', '$WORKSPACE_ID', datetime('now'), datetime('now')
FROM nc_bases_v2 b
LIMIT 1;

DETACH backup;
EOF

# 6. Применяем SQL
echo "🔧 Применяю настройки..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch.sql
'

# 7. Убираем временные файлы
sudo rm -f "$BACKUP" "$SQL_FILE"

echo "✅ Шаблон применён!"
