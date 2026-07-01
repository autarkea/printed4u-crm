#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"

echo "🔧 Привязка пользователя к workspace..."

# Проверяем, существует ли база
if [ ! -f "$DB_PATH" ]; then
    echo "❌ База данных не найдена: $DB_PATH"
    exit 1
fi

# Функция для выполнения SQL через временный контейнер Alpine
run_sql() {
    docker run --rm \
        -v /mnt/data/nocodb-data:/data \
        alpine:latest \
        sh -c "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /data/noco.db \"$1\""
}

# Проверяем, есть ли workspace
WORKSPACE_ID=$(run_sql "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "⚠️  Workspace не найден, создаю новый..."
    WORKSPACE_ID="w$(cat /dev/urandom | tr -dc 'a-z0-9' | fold -w 8 | head -n 1)"
    run_sql "INSERT INTO nc_org (id, title, meta, created_at, updated_at) VALUES ('$WORKSPACE_ID', 'Printed4U CRM', '{\"icon\":\"⛳\",\"iconType\":\"EMOJI\"}', datetime('now'), datetime('now'));"
    run_sql "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));"
    echo "✅ Workspace создан: $WORKSPACE_ID"
else
    echo "   Workspace: $WORKSPACE_ID"
fi

# Проверяем, есть ли база
BASE_ID=$(run_sql "SELECT id FROM nc_bases_v2 WHERE title='CRM' LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "❌ База CRM не найдена"
    exit 1
fi
echo "   Base: $BASE_ID"

# Находим первого пользователя
USER_ID=$(run_sql "SELECT id FROM nc_users_v2 ORDER BY created_at ASC LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден. Сначала зарегистрируйтесь!"
    exit 1
fi
echo "   User: $USER_ID"

# Добавляем в workspace (правильные имена колонок!)
run_sql "INSERT OR IGNORE INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at) VALUES ('$WORKSPACE_ID', '$USER_ID', '[\"org.owner\"]', datetime('now'), datetime('now'));"
echo "✅ Пользователь добавлен в workspace"

# Добавляем в базу (правильные имена колонок!)
run_sql "INSERT OR IGNORE INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at) VALUES ('$BASE_ID', '$USER_ID', '[\"owner\"]', '$WORKSPACE_ID', datetime('now'), datetime('now'));"
echo "✅ Пользователь добавлен в базу"

echo ""
echo "🔄 Перезапускаю NocoDB для обновления кэша..."
docker compose restart nocodb
sleep 10

echo "🎉 Готово! Перезагрузите страницу NocoDB в браузере (Ctrl+Shift+R)."
