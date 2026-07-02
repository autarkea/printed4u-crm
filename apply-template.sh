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

# 2. Получаем ID базы "Getting Started"
GETTING_STARTED_ID=$(run_sql "SELECT id FROM nc_bases_v2 WHERE title = 'Getting Started' LIMIT 1;")
if [ -z "$GETTING_STARTED_ID" ]; then
    echo "⚠️  База 'Getting Started' не найдена"
else
    echo "🗑️  Удаляю базу 'Getting Started' (ID: $GETTING_STARTED_ID)..."
    
    # Удаляем базу
    run_sql "DELETE FROM nc_bases_v2 WHERE id = '$GETTING_STARTED_ID';"
    
    # Удаляем источники данных
    run_sql "DELETE FROM nc_sources_v2 WHERE base_id = '$GETTING_STARTED_ID';"
    
    # Удаляем привязки пользователей
    run_sql "DELETE FROM nc_base_users_v2 WHERE base_id = '$GETTING_STARTED_ID';"
    
    # Удаляем таблицы (они имеют префикс nc_XXXXX___)
    TABLES=$(run_sql "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'nc_${GETTING_STARTED_ID:0:6}___%';")
    if [ ! -z "$TABLES" ]; then
        echo "$TABLES" | while IFS= read -r TABLE; do
            echo "   Удаляю таблицу: $TABLE"
            run_sql "DROP TABLE IF EXISTS \"$TABLE\";"
        done
    fi
    
    echo "✅ База 'Getting Started' удалена"
fi

# 3. Получаем ID текущей базы (должна быть одна)
CURRENT_BASE_ID=$(run_sql "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$CURRENT_BASE_ID" ]; then
    echo "❌ База не найдена"
    exit 1
fi
echo "📦 Текущая база: $CURRENT_BASE_ID"

# 4. Копируем таблицы из template.db
echo "📦 Копирую таблицы из шаблона..."

# Получаем список таблиц из template
TEMPLATE_TABLES=$(docker run --rm -v $(pwd)/$TEMPLATE:/template.db:ro alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /template.db "SELECT name FROM sqlite_master WHERE type='"'"'table'"'"' AND name LIKE '"'"'nc_nw7q___%'"'"';"
')

# Копируем каждую таблицу
echo "$TEMPLATE_TABLES" | while IFS= read -r TABLE; do
    if [ ! -z "$TABLE" ]; then
        echo "   Копирую: $TABLE"
        
        # Создаём таблицу в текущей базе
        docker run --rm \
            -v /mnt/data/nocodb-data:/data \
            -v $(pwd)/$TEMPLATE:/template.db:ro \
            alpine:latest sh -c '
            apk add --no-cache sqlite >/dev/null 2>&1
            
            # Получаем схему таблицы из template
            SCHEMA=$(sqlite3 /template.db ".schema '"$TABLE"'")
            
            # Создаём таблицу в текущей базе
            sqlite3 /data/noco.db "$SCHEMA"
            
            # Копируем данные (если есть)
            sqlite3 /data/noco.db "ATTACH DATABASE '"'"'/template.db'"'"' AS template; INSERT INTO '"$TABLE"' SELECT * FROM template.'"$TABLE"'; DETACH template;"
        '
    fi
done

echo "✅ Таблицы скопированы"

# 5. Обновляем метаданные в nc_models_v2, nc_columns_v2 и т.д.
echo "🔧 Обновляю метаданные..."

# Получаем source_id из template
TEMPLATE_SOURCE_ID=$(docker run --rm -v $(pwd)/$TEMPLATE:/template.db:ro alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /template.db "SELECT id FROM nc_sources_v2 LIMIT 1;"
')

# Создаём source в текущей базе
run_sql "INSERT INTO nc_sources_v2 (id, base_id, type, config, created_at, updated_at) VALUES ('$TEMPLATE_SOURCE_ID', '$CURRENT_BASE_ID', 'sqlite3', '{}', datetime('now'), datetime('now'));"

# Копируем метаданные таблиц
docker run --rm \
    -v /mnt/data/nocodb-data:/data \
    -v $(pwd)/$TEMPLATE:/template.db:ro \
    alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    
    # Копируем nc_models_v2 (таблицы)
    sqlite3 /data/noco.db "ATTACH DATABASE '"'"'/template.db'"'"' AS template; INSERT INTO nc_models_v2 SELECT * FROM template.nc_models_v2; DETACH template;"
    
    # Копируем nc_columns_v2 (колонки)
    sqlite3 /data/noco.db "ATTACH DATABASE '"'"'/template.db'"'"' AS template; INSERT INTO nc_columns_v2 SELECT * FROM template.nc_columns_v2; DETACH template;"
    
    # Копируем nc_views_v2 (представления)
    sqlite3 /data/noco.db "ATTACH DATABASE '"'"'/template.db'"'"' AS template; INSERT INTO nc_views_v2 SELECT * FROM template.nc_views_v2; DETACH template;"
    
    # Копируем nc_col_relations_v2 (связи)
    sqlite3 /data/noco.db "ATTACH DATABASE '"'"'/template.db'"'"' AS template; INSERT INTO nc_col_relations_v2 SELECT * FROM template.nc_col_relations_v2; DETACH template;"
'

echo "✅ Метаданные обновлены"

echo ""
echo "✅ Шаблон успешно применён!"
