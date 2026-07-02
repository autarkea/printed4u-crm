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

# 2. Получаем данные из бэкапа
USER_ID=$(docker run --rm -v /tmp:/tmp alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /tmp/noco_backup.db "SELECT id FROM nc_users_v2 LIMIT 1;"
')

if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден в бэкапе"
    exit 1
fi
echo "   User: $USER_ID"

# 3. Копируем template.db как рабочую базу
echo "📦 Копирую template.db..."
sudo rm -f "$DB_PATH"
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

# 4. Получаем ID workspace и базы из template
WORKSPACE_ID=$(docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "SELECT id FROM nc_org LIMIT 1;"
')

BASE_ID=$(docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "SELECT id FROM nc_bases_v2 LIMIT 1;"
')

if [ -z "$WORKSPACE_ID" ]; then
    echo "⚠️  Workspace не найден в template, создаю..."
    WORKSPACE_ID="w$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 8 | head -n 1)"
fi

echo "   Workspace: $WORKSPACE_ID"
echo "   Base: $BASE_ID"

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

-- Создаём workspace
INSERT INTO nc_org (id, title, meta, created_at, updated_at)
VALUES ('$WORKSPACE_ID', 'Printed4U CRM', '{"icon":"⛳","iconType":"EMOJI"}', datetime('now'), datetime('now'));

-- Копируем пользователя из бэкапа (сохраняем хеш пароля!)
INSERT INTO nc_users_v2 SELECT * FROM backup.nc_users_v2;

-- Копируем refresh tokens
INSERT INTO nc_user_refresh_tokens SELECT * FROM backup.nc_user_refresh_tokens;

-- Копируем секретные ключи
DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM backup.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id');

-- Устанавливаем NC_DEFAULT_WORKSPACE_ID
INSERT INTO nc_store (type, key, value, created_at, updated_at)
VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));

-- ВАЖНО: Обновляем workspace_id в базах и источниках!
UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID';
UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID';

-- Привязки пользователя к workspace и базе
INSERT INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at)
VALUES ('$WORKSPACE_ID', '$USER_ID', '["org.owner"]', datetime('now'), datetime('now'));

INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
VALUES ('$BASE_ID', '$USER_ID', '["owner"]', '$WORKSPACE_ID', datetime('now'), datetime('now'));

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
