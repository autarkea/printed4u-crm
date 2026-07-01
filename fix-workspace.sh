#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE_PATH="template.db"

echo "🔧 Применение шаблона базы данных..."

# Проверяем, существуют ли файлы
if [ ! -f "$DB_PATH" ]; then
    echo "❌ База данных не найдена: $DB_PATH"
    exit 1
fi

if [ ! -f "$TEMPLATE_PATH" ]; then
    echo "❌ Шаблон не найден: $TEMPLATE_PATH"
    exit 1
fi

# Функция для выполнения SQL через временный контейнер Alpine
run_sql() {
    local db_path="$1"
    local sql="$2"
    docker run --rm \
        -v /mnt/data/nocodb-data:/data \
        -v $(pwd)/$TEMPLATE_PATH:/template.db:ro \
        alpine:latest \
        sh -c "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 $db_path \"$sql\""
}

# Получаем workspace из текущей базы
WORKSPACE_ID=$(run_sql "/data/noco.db" "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Workspace не найден в текущей базе"
    exit 1
fi
echo "   Workspace: $WORKSPACE_ID"

# Получаем пользователя из текущей базы
USER_ID=$(run_sql "/data/noco.db" "SELECT id FROM nc_users_v2 LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден в текущей базе"
    exit 1
fi
echo "   User: $USER_ID"

# Получаем базу из текущей базы
BASE_ID=$(run_sql "/data/noco.db" "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "❌ База не найдена в текущей базе"
    exit 1
fi
echo "   Base: $BASE_ID"

# Получаем секретные ключи из текущей базы
JWT_SECRET=$(run_sql "/data/noco.db" "SELECT value FROM nc_store WHERE key='nc_auth_jwt_secret';")
SERVER_ID=$(run_sql "/data/noco.db" "SELECT value FROM nc_store WHERE key='nc_server_id';")

# Копируем шаблон как новую базу
echo "📦 Копирую шаблон..."
cp "$TEMPLATE_PATH" "$DB_PATH.new"

# Добавляем workspace в шаблон
echo "🔧 Добавляю workspace в шаблон..."
run_sql "/data/noco.db.new" "INSERT INTO nc_org (id, title, meta, created_at, updated_at) SELECT id, title, meta, created_at, updated_at FROM (SELECT '$WORKSPACE_ID' as id, 'Printed4U CRM' as title, '{\"icon\":\"⛳\",\"iconType\":\"EMOJI\"}' as meta, datetime('now') as created_at, datetime('now') as updated_at);"

# Добавляем пользователя в шаблон
echo "🔧 Добавляю пользователя в шаблон..."
run_sql "/data/noco.db.new" "INSERT INTO nc_users_v2 SELECT * FROM (SELECT '$USER_ID' as id, email, password, salt, role, invite_token, reset_password_req, created_at, updated_at FROM (SELECT 'user@example.com' as email, '' as password, '' as salt, 'org.owner' as role, NULL as invite_token, 0 as reset_password_req, datetime('now') as created_at, datetime('now') as updated_at));"

# Добавляем привязки
echo "🔧 Добавляю привязки..."
run_sql "/data/noco.db.new" "INSERT INTO nc_org_users (fk_org_id, fk_user_id, roles, created_at, updated_at) VALUES ('$WORKSPACE_ID', '$USER_ID', '[\"org.owner\"]', datetime('now'), datetime('now'));"
run_sql "/data/noco.db.new" "INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at) VALUES ('$BASE_ID', '$USER_ID', '[\"owner\"]', '$WORKSPACE_ID', datetime('now'), datetime('now'));"

# Добавляем секретные ключи
echo "🔧 Добавляю секретные ключи..."
run_sql "/data/noco.db.new" "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'nc_auth_jwt_secret', '$JWT_SECRET', datetime('now'), datetime('now'));"
run_sql "/data/noco.db.new" "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'nc_server_id', '$SERVER_ID', datetime('now'), datetime('now'));"
run_sql "/data/noco.db.new" "INSERT OR REPLACE INTO nc_store (type, key, value, created_at, updated_at) VALUES ('db', 'NC_DEFAULT_WORKSPACE_ID', '$WORKSPACE_ID', datetime('now'), datetime('now'));"

# Заменяем старую базу на новую
echo "🔄 Заменяю базу данных..."
mv "$DB_PATH.new" "$DB_PATH"
sudo chown 1000:1000 "$DB_PATH"

echo "✅ Шаблон применён!"
