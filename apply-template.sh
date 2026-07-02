#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_backup.db"

echo "🔧 Применение шаблона базы данных..."

# 1. Функция для SQL
run_sql() {
    docker run --rm -v /mnt/data/nocodb-data:/data \
        -v /tmp:/tmp \
        alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /data/noco.db "'"$1"'"
    '
}

# 2. Делаем бэкап текущей базы (с настоящим пользователем и паролем)
echo "💾 Делаю бэкап текущей базы..."
sudo cp "$DB_PATH" "$BACKUP"
sudo chmod 666 "$BACKUP"

# 3. Получаем данные из текущей базы
WORKSPACE_ID=$(run_sql "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "⚠️  Workspace не найден, создаю..."
    WORKSPACE_ID="w$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 8 | head -n 1)"
    run_sql "INSERT INTO nc_org (id, title, meta, created_at, updated_at) VALUES ('$WORKSPACE_ID', 'Printed4U CRM', '{\"icon\":\"⛳\",\"iconType\":\"EMOJI\"}', datetime('now'), datetime('now'));"
    run_sql "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));"
    echo "✅ Workspace создан: $WORKSPACE_ID"
else
    echo "   Workspace: $WORKSPACE_ID"
fi

USER_ID=$(run_sql "SELECT id FROM nc_users_v2 LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден"
    exit 1
fi
echo "   User: $USER_ID"

# 4. Копируем шаблон как рабочую базу
echo "📦 Копирую шаблон..."
sudo rm -f "$DB_PATH"
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

# 5. Применяем всё одним SQL-файлом с ATTACH DATABASE
SQL_FILE="/tmp/patch.sql"
cat > "$SQL_FILE" <<EOF
-- Подключаем бэкап
ATTACH DATABASE '/tmp/noco_backup.db' AS backup;

-- Очищаем workspace и пользователей из шаблона
DELETE FROM nc_org;
DELETE FROM nc_users_v2;
DELETE FROM nc_org_users;
DELETE FROM nc_base_users_v2;
DELETE FROM nc_user_refresh_tokens;
DELETE FROM nc_api_tokens;
DELETE FROM nc_bases_v2 WHERE title = 'Getting Started';

-- Копируем пользователя ЦЕЛИКОМ из бэкапа (сохраняем хеш пароля!)
INSERT INTO nc_users_v2 SELECT * FROM backup.nc_users_v2;

-- Копируем refresh tokens из бэкапа (чтобы сессия работала)
INSERT INTO nc_user_refresh_tokens SELECT * FROM backup.nc_user_refresh_tokens;

-- Создаём workspace
INSERT INTO nc_org (id, title, meta, created_at, updated_at)
VALUES ('$WORKSPACE_ID', 'Printed4U CRM', '{"icon":"⛳","iconType":"EMOJI"}', datetime('now'), datetime('now'));

-- Обновляем workspace_id в источниках и базах
UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID';
UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID';

-- Устанавливаем NC_DEFAULT_WORKSPACE_ID
DELETE FROM nc_store WHERE key = 'NC_DEFAULT_WORKSPACE_ID';
INSERT INTO nc_store (type, key, value, created_at, updated_at)
VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));

-- Копируем секретные ключи из бэкапа
DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM backup.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id');

-- Добавляем привязки пользователя к workspace и базе
INSERT INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at)
SELECT '$WORKSPACE_ID', id, '["org.owner"]', datetime('now'), datetime('now')
FROM nc_users_v2 LIMIT 1;

INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
SELECT b.id, u.id, '["owner"]', '$WORKSPACE_ID', datetime('now'), datetime('now')
FROM nc_bases_v2 b, nc_users_v2 u
WHERE b.title != 'Getting Started'
LIMIT 1;

DETACH backup;
EOF

# 6. Применяем SQL
echo "🔧 Применяю настройки (копирую пользователя из бэкапа)..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch.sql
'

# 7. Убираем временные файлы
rm -f "$BACKUP" "$SQL_FILE"

echo "✅ Шаблон применён с сохранением пароля пользователя!"
