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

# 3. Ищем workspace в таблице `workspace` (NocoDB CE использует её!)
WORKSPACE_ID=$(run_sql_backup "SELECT id FROM workspace LIMIT 1;")
USER_ID=$(run_sql_backup "SELECT id FROM nc_users_v2 LIMIT 1;")

if [ -z "$WORKSPACE_ID" ] || [ -z "$USER_ID" ]; then
    echo "❌ Workspace или пользователь не найдены в бэкапе"
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

-- Очищаем workspace
DELETE FROM workspace;
DELETE FROM workspace_user;
DELETE FROM nc_org;
DELETE FROM nc_org_users;

-- Копируем пользователя из бэкапа
INSERT INTO nc_users_v2 SELECT * FROM backup.nc_users_v2;
INSERT INTO nc_user_refresh_tokens SELECT * FROM backup.nc_user_refresh_tokens;

-- Копируем workspace из бэкапа
INSERT INTO workspace SELECT * FROM backup.workspace;
INSERT INTO workspace_user SELECT * FROM backup.workspace_user;

-- Копируем секретные ключи
DELETE FROM nc_store WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');
INSERT INTO nc_store (type, key, value, created_at, updated_at)
SELECT type, key, value, created_at, updated_at FROM backup.nc_store
WHERE key IN ('nc_auth_jwt_secret', 'nc_server_id', 'NC_DEFAULT_WORKSPACE_ID');

-- Удаляем пустые модели
DELETE FROM nc_models_v2 WHERE table_name = '' OR table_name IS NULL;

-- Привязки пользователя к базе
INSERT INTO nc_base_users_v2 (base_id, fk_user_id, roles, fk_workspace_id, created_at, updated_at)
SELECT b.id, '$USER_ID', '["owner"]', '$WORKSPACE_ID', datetime('now'), datetime('now')
FROM nc_bases_v2 b LIMIT 1;

DETACH backup;
EOF

# 6. Применяем SQL
echo "🔧 Применяю базовые настройки..."
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v /tmp:/tmp \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db < /tmp/patch.sql
'

# 7. УДАЛЯЕМ старые логи (не нужны)
echo "🗑️  Очищаю старые логи..."
docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "DELETE FROM nc_audit_v2;"
    sqlite3 /data/noco.db "DELETE FROM nc_operation_logs;"
    sqlite3 /data/noco.db "DELETE FROM nc_hook_logs_v2;"
'

# 8. ГЛАВНОЕ: Обновляем fk_workspace_id ВЕЗДЕ
echo "🔧 Обновляю fk_workspace_id во ВСЕХ таблицах..."
docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c "
    apk add --no-cache sqlite >/dev/null 2>&1
    
    for TABLE in \$(sqlite3 /data/noco.db \".tables\"); do
        HAS_WS=\$(sqlite3 /data/noco.db \"PRAGMA table_info(\$TABLE);\" | grep -c 'fk_workspace_id' || true)
        if [ \"\$HAS_WS\" -gt 0 ]; then
            sqlite3 /data/noco.db \"UPDATE \$TABLE SET fk_workspace_id = '$WORKSPACE_ID' WHERE fk_workspace_id IS NOT NULL;\"
        fi
    done
    echo '✅ Все таблицы обновлены'
"

# 9. Убираем временные файлы
sudo rm -f "$BACKUP" "$SQL_FILE"

echo "✅ Шаблон применён!"
