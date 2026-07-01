#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_backup.db"

echo "🔧 Применение шаблона базы данных..."

# 1. Бэкап текущей базы (с пользователем и workspace)
cp "$DB_PATH" "$BACKUP"
echo "💾 Бэкап создан"

# 2. Забираем workspace, пользователя и секреты из бэкапа
WORKSPACE_ID=$(docker run --rm -v /tmp:/tmp alpine:latest sh -c 'apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /tmp/noco_backup.db "SELECT id FROM nc_org LIMIT 1;"')
USER_ROW=$(docker run --rm -v /tmp:/tmp alpine:latest sh -c 'apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /tmp/noco_backup.db "SELECT id FROM nc_users_v2 LIMIT 1;"')
JWT=$(docker run --rm -v /tmp:/tmp alpine:latest sh -c 'apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /tmp/noco_backup.db "SELECT value FROM nc_store WHERE key='"'"'nc_auth_jwt_secret'"'"' LIMIT 1;"')
SID=$(docker run --rm -v /tmp:/tmp alpine:latest sh -c 'apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /tmp/noco_backup.db "SELECT value FROM nc_store WHERE key='"'"'nc_server_id'"'"' LIMIT 1;"')

echo "   Workspace: $WORKSPACE_ID"
echo "   User: $USER_ROW"

if [ -z "$WORKSPACE_ID" ] || [ -z "$USER_ROW" ]; then
    echo "❌ Не удалось получить workspace или пользователя из бэкапа"
    exit 1
fi

# 3. Копируем шаблон как рабочую базу
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"
echo "📦 Шаблон скопирован"

# 4. Создаём SQL-файл
SQL_FILE="/tmp/patch.sql"
cat > "$SQL_FILE" <<EOF
DELETE FROM nc_org;
DELETE FROM nc_users_v2;
DELETE FROM nc_org_users;
DELETE FROM nc_base_users_v2;
DELETE FROM nc_user_refresh_tokens;

ATTACH DATABASE '/tmp/noco_backup.db' AS src;

INSERT INTO nc_org SELECT * FROM src.nc_org;
INSERT INTO nc_users_v2 SELECT * FROM src.nc_users_v2;
INSERT INTO nc_org_users SELECT * FROM src.nc_org_users;

INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
SELECT b.id, u.id, '["owner"]', o.id, datetime('now'), datetime('now')
FROM nc_bases_v2 b, nc_users_v2 u, nc_org o
WHERE b.title != 'Getting Started'
LIMIT 1;

DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM src.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');

UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID';
UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID';

DELETE FROM nc_bases_v2 WHERE title = 'Getting Started';

DETACH src;
EOF

# 5. Применяем SQL
echo "🔧 Применяю настройки..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch.sql
'

# 6. Убираем временные файлы
rm -f "$BACKUP" "$SQL_FILE"

echo "✅ Шаблон успешно применён с сохранением пользователя!"
