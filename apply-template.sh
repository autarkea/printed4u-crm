#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"

echo "🔧 Привязка базы CRM к workspace..."

# Функция для SQL
run_sql() {
    docker run --rm -v /mnt/data/nocodb-data:/data \
        alpine:latest sh -c '
        apk add --no-cache sqlite >/dev/null 2>&1
        sqlite3 /data/noco.db "'"$1"'"
    '
}

# 1. Получаем ID workspace (создан NocoDB автоматически)
WORKSPACE_ID=$(run_sql "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Workspace не найден"
    exit 1
fi
echo "   Workspace: $WORKSPACE_ID"

# 2. Получаем ID пользователя
USER_ID=$(run_sql "SELECT id FROM nc_users_v2 LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден"
    exit 1
fi
echo "   User: $USER_ID"

# 3. Получаем ID базы CRM
BASE_ID=$(run_sql "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "❌ База не найдена"
    exit 1
fi
echo "   Base: $BASE_ID"

# 4. Обновляем fk_workspace_id в базе и источнике
echo "🔧 Обновляю fk_workspace_id..."
run_sql "UPDATE nc_bases_v2 SET fk_workspace_id = '$WORKSPACE_ID' WHERE id = '$BASE_ID';"
run_sql "UPDATE nc_sources_v2 SET fk_workspace_id = '$WORKSPACE_ID' WHERE base_id = '$BASE_ID';"

# 5. Добавляем привязки пользователя к базе
echo "🔧 Привязываю пользователя к базе..."
run_sql "INSERT OR IGNORE INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at) VALUES ('$BASE_ID', '$USER_ID', '[\"owner\"]', '$WORKSPACE_ID', datetime('now'), datetime('now'));"

# 6. Устанавливаем NC_DEFAULT_WORKSPACE_ID
run_sql "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));"

echo "✅ База CRM привязана к workspace!"
