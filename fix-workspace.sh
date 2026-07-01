#!/bin/bash
set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"

echo "🔧 Привязка пользователя к workspace..."

# Проверяем, существует ли база
if [ ! -f "$DB_PATH" ]; then
    echo "❌ База данных не найдена: $DB_PATH"
    exit 1
fi

# Используем Docker-контейнер с sqlite3 (не засоряет хост)
SQLITE_CMD="docker run --rm -v /mnt/data/nocodb-data:/data alpine/sqlite3:latest /data/noco.db"

# Находим workspace
WORKSPACE_ID=$($SQLITE_CMD "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Workspace не найден"
    exit 1
fi
echo "   Workspace: $WORKSPACE_ID"

# Находим базу
BASE_ID=$($SQLITE_CMD "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "❌ База не найдена"
    exit 1
fi
echo "   Base: $BASE_ID"

# Находим первого пользователя
USER_ID=$($SQLITE_CMD "SELECT id FROM nc_users_v2 ORDER BY created_at ASC LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден. Сначала зарегистрируйтесь!"
    exit 1
fi
echo "   User: $USER_ID"

# Добавляем в workspace
$SQLITE_CMD "INSERT OR IGNORE INTO nc_org_users (id, org_id, user_id, roles, created_at, updated_at) VALUES ('ou_$(date +%s)', '$WORKSPACE_ID', '$USER_ID', '[\"org.owner\"]', datetime('now'), datetime('now'));"
echo "✅ Пользователь добавлен в workspace"

# Добавляем в базу
$SQLITE_CMD "INSERT OR IGNORE INTO nc_base_users_v2 (id, base_id, user_id, roles, created_at, updated_at) VALUES ('bu_$(date +%s)', '$BASE_ID', '$USER_ID', '[\"owner\"]', datetime('now'), datetime('now'));"
echo "✅ Пользователь добавлен в базу"

echo ""
echo "🎉 Готово! Перезагрузите страницу NocoDB в браузере."
