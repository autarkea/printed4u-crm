#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Экспорт рабочей базы в шаблон template.db            ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_export_backup_$(date +%Y%m%d_%H%M%S).db"

# Проверка, что NocoDB запущен
if ! docker ps | grep -q nocodb; then
    echo -e "${RED}❌ NocoDB не запущен!${NC}"
    exit 1
fi

# ============================================
# ШАГ 1: Бэкап текущей рабочей базы
# ============================================
echo -e "${BLUE}📦 Шаг 1/8: Делаю бэкап рабочей базы...${NC}"
sudo cp "$DB_PATH" "$BACKUP"
echo -e "${GREEN}✅ Бэкап создан: $BACKUP${NC}"
echo ""

# ============================================
# ШАГ 2: Останавливаем NocoDB
# ============================================
echo -e "${BLUE}🛑 Шаг 2/8: Останавливаю NocoDB...${NC}"
docker stop nocodb
sleep 3
echo -e "${GREEN}✅ NocoDB остановлен${NC}"
echo ""

# ============================================
# ШАГ 3: Копируем базу в template.db
# ============================================
echo -e "${BLUE}📋 Шаг 3/8: Копирую базу в template.db...${NC}"
cp "$DB_PATH" "$TEMPLATE"
echo -e "${GREEN}✅ Скопировано${NC}"
echo ""

# ============================================
# ШАГ 4: Удаляем workspace и пользователей
# ============================================
echo -e "${BLUE}🗑️  Шаг 4/8: Удаляю workspace и пользователей...${NC}"
sqlite3 "$TEMPLATE" "DELETE FROM workspace;"
sqlite3 "$TEMPLATE" "DELETE FROM workspace_user;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_org;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_org_users;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_users_v2;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_user_refresh_tokens;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_api_tokens;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_base_users_v2;"
echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 5: Удаляем секреты и NC_DEFAULT_WORKSPACE_ID
# ============================================
echo -e "${BLUE}🔑 Шаг 5/8: Удаляю секреты и NC_DEFAULT_WORKSPACE_ID...${NC}"
sqlite3 "$TEMPLATE" "DELETE FROM nc_store WHERE key IN ('NC_DEFAULT_WORKSPACE_ID', 'nc_auth_jwt_secret', 'nc_server_id');"
echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 6: Удаляем старые базы (не CRM)
# ============================================
echo -e "${BLUE}🗑️  Шаг 6/8: Удаляю старые базы и их метаданные...${NC}"

# Получаем ID базы CRM
CRM_BASE_ID=$(sqlite3 "$TEMPLATE" "SELECT id FROM nc_bases_v2 WHERE title='CRM' LIMIT 1;")
if [ -z "$CRM_BASE_ID" ]; then
    echo -e "${RED}❌ База CRM не найдена!${NC}"
    docker start nocodb
    exit 1
fi
echo "   CRM Base ID: $CRM_BASE_ID"

# Удаляем все базы кроме CRM
sqlite3 "$TEMPLATE" "DELETE FROM nc_bases_v2 WHERE id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "DELETE FROM nc_sources_v2 WHERE base_id != '$CRM_BASE_ID';"

# Удаляем все модели, колонки, views не относящиеся к CRM
sqlite3 "$TEMPLATE" "DELETE FROM nc_models_v2 WHERE base_id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "DELETE FROM nc_columns_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);"
sqlite3 "$TEMPLATE" "DELETE FROM nc_views_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);"
sqlite3 "$TEMPLATE" "DELETE FROM nc_col_relations_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);"

# Удаляем пустые модели (без table_name)
sqlite3 "$TEMPLATE" "DELETE FROM nc_models_v2 WHERE table_name = '' OR table_name IS NULL;"

echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 7: Удаляем физические таблицы других баз
# ============================================
echo -e "${BLUE}🗑️  Шаг 7/8: Удаляю физические таблицы других баз...${NC}"
for PREFIX in "nc_r_8e" "nc_s3ar" "nc_rx07" "nc_pgkldd" "nc_p5g9xj" "nc_bx7r09"; do
    TABLES=$(sqlite3 "$TEMPLATE" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '${PREFIX}___%';")
    if [ ! -z "$TABLES" ]; then
        echo "$TABLES" | while IFS= read -r TABLE; do
            sqlite3 "$TEMPLATE" "DROP TABLE IF EXISTS \"$TABLE\";"
        done
    fi
done
echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 8: Очищаем данные из таблиц CRM
# ============================================
echo -e "${BLUE}🧹 Шаг 8/8: Очищаю данные из таблиц CRM (оставляю структуру)...${NC}"
sqlite3 "$TEMPLATE" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'nc_nw7q___%';" | while IFS= read -r TABLE; do
    if [ ! -z "$TABLE" ]; then
        sqlite3 "$TEMPLATE" "DELETE FROM \"$TABLE\";"
        echo "   ✅ $TABLE"
    fi
done

# Очищаем fk_workspace_id ВЕЗДЕ (важно!)
sqlite3 "$TEMPLATE" "UPDATE nc_bases_v2 SET fk_workspace_id = '';"
sqlite3 "$TEMPLATE" "UPDATE nc_sources_v2 SET fk_workspace_id = '';"
sqlite3 "$TEMPLATE" "UPDATE nc_models_v2 SET fk_workspace_id = '';"
sqlite3 "$TEMPLATE" "UPDATE nc_views_v2 SET fk_workspace_id = '';"
sqlite3 "$TEMPLATE" "UPDATE nc_columns_v2 SET fk_workspace_id = '';"

# Очищаем логи
sqlite3 "$TEMPLATE" "DELETE FROM nc_audit_v2;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_operation_logs;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_hook_logs_v2;"

# Сбрасываем автоинкремент
sqlite3 "$TEMPLATE" "DELETE FROM sqlite_sequence;" 2>/dev/null || true

echo -e "${GREEN}✅ Очищено${NC}"
echo ""

# ============================================
# Запускаем NocoDB обратно
# ============================================
echo -e "${BLUE}🚀 Запускаю NocoDB обратно...${NC}"
docker start nocodb
sleep 5
echo -e "${GREEN}✅ NocoDB запущен${NC}"
echo ""

# ============================================
# Финальная проверка
# ============================================
echo -e "${BLUE}🔍 Финальная проверка:${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
sqlite3 "$TEMPLATE" "SELECT '📦 Базы: ' || COUNT(*) FROM nc_bases_v2;"
sqlite3 "$TEMPLATE" "SELECT '🔌 Источники: ' || COUNT(*) FROM nc_sources_v2;"
sqlite3 "$TEMPLATE" "SELECT '📊 Модели CRM: ' || COUNT(*) FROM nc_models_v2 WHERE base_id='$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "SELECT '📊 Модели ДРУГИЕ: ' || COUNT(*) FROM nc_models_v2 WHERE base_id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "SELECT '📋 Колонки: ' || COUNT(*) FROM nc_columns_v2;"
sqlite3 "$TEMPLATE" "SELECT '👁️  Views: ' || COUNT(*) FROM nc_views_v2;"
sqlite3 "$TEMPLATE" "SELECT '🏢 Workspace: ' || COUNT(*) FROM workspace;"
sqlite3 "$TEMPLATE" "SELECT '👤 Пользователи: ' || COUNT(*) FROM nc_users_v2;"
sqlite3 "$TEMPLATE" "SELECT '🔑 NC_DEFAULT_WORKSPACE_ID: ' || COUNT(*) FROM nc_store WHERE key='NC_DEFAULT_WORKSPACE_ID';"
sqlite3 "$TEMPLATE" "SELECT '📁 Таблицы CRM (физические): ' || COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'nc_nw7q___%';"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Шаблон template.db готов к коммиту!                 ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📤 Следующие шаги:${NC}"
echo "   git add template.db"
echo "   git commit -m \"🔧 Update template.db\""
echo "   git push origin main"
echo ""
echo -e "${YELLOW}💾 Бэкап сохранён: $BACKUP${NC}"
