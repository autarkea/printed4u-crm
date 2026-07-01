#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"

echo "🔧 Применение шаблона базы данных..."

# 1. Функция для SQL
run_sql() {
    docker run --rm -v /mnt/data/nocodb-data:/data \
        alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /data/noco.db "'"$1"'"
    '
}

# 2. Проверяем, есть ли workspace
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

# 3. Получаем пользователя
USER_ID=$(run_sql "SELECT id FROM nc_users_v2 LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден"
    exit 1
fi
echo "   User: $USER_ID"

# 4. Получаем базу (кроме Getting Started)
BASE_ID=$(run_sql "SELECT id FROM nc_bases_v2 WHERE title != 'Getting Started' LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "⚠️  База не найдена, создаю..."
    # Копируем базу из шаблона
    BASE_ID=$(docker run --rm -v $(pwd)/$TEMPLATE:/template.db:ro alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /template.db "SELECT id FROM nc_bases_v2 LIMIT 1;"
    ')
    echo "✅ База из шаблона: $BASE_ID"
fi
echo "   Base: $BASE_ID"

# 5. Копируем шаблон как рабочую базу
echo "📦 Копирую шаблон..."
cp "$TEMPLATE" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

# 6. Создаём SQL для обновления шаблона
SQL_FILE="/tmp/patch.sql"
cat > "$SQL_FILE" <<EOF
-- Очищаем workspace и пользователей из шаблона
DELETE FROM nc_org;
DELETE FROM nc_users_v2;
DELETE FROM nc_org_users;
DELETE FROM nc_base_users_v2;
DELETE FROM nc_user_refresh_tokens;

-- Вставляем наш workspace
INSERT INTO nc_org (id, title, meta, created_at, updated_at)
VALUES ('$WORKSPACE_ID', 'Printed4U CRM', '{"icon":"⛳","iconType":"EMOJI"}', datetime('now'), datetime('now'));

-- Устанавливаем NC_DEFAULT_WORKSPACE_ID
DELETE FROM nc_store WHERE key = 'NC_DEFAULT_WORKSPACE_ID';
INSERT INTO nc_store (type, key, value, created_at, updated_at)
VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));

-- Обновляем workspace_id в источниках и базах
UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID';
UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID';

-- Удаляем демо-базу
DELETE FROM nc_bases_v2 WHERE title = 'Getting Started';
EOF

# 7. Применяем SQL к шаблону
echo "🔧 Применяю настройки..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch.sql
'

# 8. Добавляем пользователя
echo "👤 Добавляю пользователя..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    alpine:latest sh -c "
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db \"INSERT INTO nc_users_v2 (id, email, password, salt, role, invite_token, reset_password_req, created_at, updated_at) SELECT id, email, password, salt, role, invite_token, reset_password_req, created_at, updated_at FROM (SELECT '$USER_ID' as id, 'user@example.com' as email, '' as password, '' as salt, 'org.owner' as role, NULL as invite_token, 0 as reset_password_req, datetime('now') as created_at, datetime('now') as updated_at);\"
    
    sqlite3 /data/noco.db \"INSERT INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at) VALUES ('$WORKSPACE_ID', '$USER_ID', '[\\\"org.owner\\\"]', datetime('now'), datetime('now'));\"
    
    sqlite3 /data/noco.db \"INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at) SELECT id, '$USER_ID', '[\\\"owner\\\"]', '$WORKSPACE_ID', datetime('now'), datetime('now') FROM nc_bases_v2 WHERE title != 'Getting Started' LIMIT 1;\"
"

# 9. Убираем временные файлы
rm -f "$SQL_FILE"

echo "✅ Шаблон успешно применён!"
