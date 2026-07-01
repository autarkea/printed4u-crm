#!/bin/bash
# fix-workspace.sh - Добавляет первого зарегистрированного пользователя в workspace и базу из шаблона

set -e

DB_PATH="/mnt/data/nocodb-data/noco.db"

if [ ! -f "$DB_PATH" ]; then
    echo "❌ База данных не найдена: $DB_PATH"
    exit 1
fi

echo "🔧 Исправляю привязки пользователя к workspace..."

# 1. Находим ID workspace (должен быть один)
WORKSPACE_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM nc_org LIMIT 1;")
if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Workspace не найден"
    exit 1
fi
echo "   Workspace ID: $WORKSPACE_ID"

# 2. Находим ID базы (должна быть одна)
BASE_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$BASE_ID" ]; then
    echo "❌ База данных не найдена"
    exit 1
fi
echo "   Base ID: $BASE_ID"

# 3. Находим ID первого реального пользователя (не системного)
# Системные пользователи обычно имеют email типа "system@..." или id начинающийся с "us_"
USER_ID=$(sqlite3 "$DB_PATH" "SELECT id FROM nc_users_v2 WHERE email NOT LIKE 'system@%' ORDER BY created_at ASC LIMIT 1;")
if [ -z "$USER_ID" ]; then
    echo "❌ Пользователь не найден. Сначала зарегистрируйтесь в NocoDB!"
    exit 1
fi
echo "   User ID: $USER_ID"

# 4. Проверяем, есть ли уже привязка
EXISTING_ORG=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM nc_org_users WHERE user_id='$USER_ID' AND org_id='$WORKSPACE_ID';")
if [ "$EXISTING_ORG" -gt 0 ]; then
    echo "✅ Пользователь уже привязан к workspace"
else
    # 5. Добавляем пользователя в workspace
    sqlite3 "$DB_PATH" "INSERT INTO nc_org_users (id, org_id, user_id, roles, created_at, updated_at) VALUES ('ou_$(date +%s)', '$WORKSPACE_ID', '$USER_ID', '[\"org.owner\"]', datetime('now'), datetime('now'));"
    echo "✅ Пользователь добавлен в workspace"
fi

# 6. Проверяем, есть ли привязка к базе
EXISTING_BASE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM nc_base_users_v2 WHERE user_id='$USER_ID' AND base_id='$BASE_ID';")
if [ "$EXISTING_BASE" -gt 0 ]; then
    echo "✅ Пользователь уже привязан к базе"
else
    # 7. Добавляем пользователя в базу с ролью owner
    sqlite3 "$DB_PATH" "INSERT INTO nc_base_users_v2 (id, base_id, user_id, roles, created_at, updated_at) VALUES ('bu_$(date +%s)', '$BASE_ID', '$USER_ID', '[\"owner\"]', datetime('now'), datetime('now'));"
    echo "✅ Пользователь добавлен в базу"
fi

echo ""
echo " Готово! Перезагрузите страницу NocoDB в браузере."
