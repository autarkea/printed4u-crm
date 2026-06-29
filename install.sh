#!/bin/bash

# ============================================
# Printed4U CRM - Автоматический установщик
# Версия: 1.0.0
# ============================================

set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}║   🚀 Printed4U CRM - Автоматическая установка            ║${NC}"
echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}║   Версия: 1.0.0                                           ║${NC}"
echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================
# ШАГ 1: Проверка зависимостей
# ============================================
echo -e "${BLUE}📦 Шаг 1/6: Проверка зависимостей...${NC}"

# Проверяем curl
if ! command -v curl &> /dev/null; then
    echo -e "${RED}❌ curl не установлен${NC}"
    echo "Установи: sudo apt install curl"
    exit 1
fi

# Проверяем Docker
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠️  Docker не установлен. Устанавливаю...${NC}"
    
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl gnupg
    
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✅ Docker установлен${NC}"
    echo -e "${YELLOW}️  Важно: перезайди в систему или выполни: newgrp docker${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Docker найден: $(docker --version)${NC}"
fi

# Проверяем Docker Compose
if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose не установлен${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Docker Compose найден: $(docker compose version)${NC}"
fi

# Проверяем git
if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}️  Git не установлен. Устанавливаю...${NC}"
    sudo apt-get install -y git
    echo -e "${GREEN}✅ Git установлен${NC}"
else
    echo -e "${GREEN}✅ Git найден${NC}"
fi

echo ""

# ============================================
# ШАГ 2: Создание папок для данных
# ============================================
echo -e "${BLUE}📁 Шаг 2/6: Создание папок для данных...${NC}"

DATA_DIR="/mnt/data"
sudo mkdir -p $DATA_DIR/projects
sudo mkdir -p $DATA_DIR/clients
sudo mkdir -p $DATA_DIR/noco-static/pdfs
sudo mkdir -p $DATA_DIR/backups
sudo mkdir -p $DATA_DIR/nocodb

sudo chown -R $USER:$USER $DATA_DIR

echo -e "${GREEN}✅ Папки созданы в $DATA_DIR${NC}"
echo ""

# ============================================
# ШАГ 3: Скачивание кода
# ============================================
echo -e "${BLUE}📥 Шаг 3/6: Скачивание кода...${NC}"

INSTALL_DIR="/opt/printed4u-crm"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Папка $INSTALL_DIR уже существует${NC}"
    read -p "Удалить и скачать заново? (y/N): " answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        sudo rm -rf $INSTALL_DIR
    else
        echo "Используем существующую установку"
        cd $INSTALL_DIR
        git pull origin main
        echo -e "${GREEN}✅ Код обновлён${NC}"
    fi
fi

if [ ! -d "$INSTALL_DIR" ]; then
    echo "Скачиваю с GitHub..."
    cd /opt
    sudo git clone https://github.com/autarkea/printed4u-crm.git
    sudo chown -R $USER:$USER printed4u-crm
    cd printed4u-crm
    echo -e "${GREEN}✅ Код скачан${NC}"
else
    cd $INSTALL_DIR
fi

echo ""

# ============================================
# ШАГ 4: Создание .env файла
# ============================================
echo -e "${BLUE}⚙️  Шаг 4/6: Настройка конфигурации...${NC}"

ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}⚠️  Файл .env уже существует${NC}"
    read -p "Перезаписать? (y/N): " answer
    if [ "$answer" != "y" ] && [ "$answer" != "Y" ]; then
        echo "Пропускаем создание .env"
    else
        cp .env.example .env
    fi
else
    cp .env.example .env
fi

echo ""
echo -e "${YELLOW}Заполни данные (или нажми Enter чтобы оставить как есть):${NC}"
echo ""

read -p "Telegram Bot Token: " bot_token
if [ ! -z "$bot_token" ]; then
    sed -i "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$bot_token/" .env
fi

read -p "Telegram User ID (твой ID): " user_id
if [ ! -z "$user_id" ]; then
    sed -i "s/TELEGRAM_USER_ID=.*/TELEGRAM_USER_ID=$user_id/" .env
fi

read -p "NocoDB URL (например http://localhost:8081/api/v1/db/data): " noco_url
if [ ! -z "$noco_url" ]; then
    sed -i "s|NOCO_URL=.*|NOCO_URL=$noco_url|" .env
fi

read -p "NocoDB API Token: " noco_token
if [ ! -z "$noco_token" ]; then
    sed -i "s/NOCO_TOKEN=.*/NOCO_TOKEN=$noco_token/" .env
fi

read -p "NocoDB Base ID: " base_id
if [ ! -z "$base_id" ]; then
    sed -i "s/BASE_ID=.*/BASE_ID=$base_id/" .env
fi

read -p "SMTP Host (например smtp.gmail.com): " smtp_host
if [ ! -z "$smtp_host" ]; then
    sed -i "s/SMTP_HOST=.*/SMTP_HOST=$smtp_host/" .env
fi

read -p "SMTP User (email): " smtp_user
if [ ! -z "$smtp_user" ]; then
    sed -i "s/SMTP_USER=.*/SMTP_USER=$smtp_user/" .env
fi

read -p "SMTP Password (app password): " smtp_pass
if [ ! -z "$smtp_pass" ]; then
    sed -i "s/SMTP_PASS=.*/SMTP_PASS=$smtp_pass/" .env
fi

read -p "Webhook Secret (любой случайный набор символов): " webhook_secret
if [ ! -z "$webhook_secret" ]; then
    sed -i "s/WEBHOOK_SECRET=.*/WEBHOOK_SECRET=$webhook_secret/" .env
fi

echo -e "${GREEN}✅ .env настроен${NC}"
echo ""

# ============================================
# ШАГ 5: Автопоиск ID таблиц в NocoDB
# ============================================
echo -e "${BLUE}🔍 Шаг 5/6: Поиск ID таблиц в NocoDB...${NC}"

# Загружаем переменные из .env
source .env

# Функция для поиска таблицы по имени
find_table_id() {
    local table_name=$1
    local env_var=$2
    
    echo -n "   Поиск таблицы '$table_name'... "
    
    # Запрашиваем список таблиц из NocoDB
    local response=$(curl -s "$NOCO_URL/meta/tables" \
        -H "xc-token: $NOCO_TOKEN" 2>/dev/null)
    
    # Ищем ID таблицы по имени
    local table_id=$(echo "$response" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for table in data.get('list', []):
    if table.get('title') == '$table_name':
        print(table.get('id', ''))
        break
" 2>/dev/null)
    
    if [ ! -z "$table_id" ]; then
        echo -e "${GREEN}✅ ID: $table_id${NC}"
        sed -i "s/$env_var=.*/$env_var=$table_id/" .env
    else
        echo -e "${RED}❌ Не найдена${NC}"
        echo -e "${YELLOW}   Заполни вручную: $env_var=ID_ТАБЛИЦЫ${NC}"
    fi
}

# Ищем все таблицы
find_table_id "Задачи" "TABLE_TASKS"
find_table_id "Контакты" "TABLE_CONTACTS"
find_table_id "Проекты" "TABLE_PROJECTS"
find_table_id "Документы" "TABLE_DOCUMENTS"
find_table_id "Позиции" "TABLE_ITEMS"
find_table_id "Юрлица" "TABLE_LEGAL_ENTITIES"
find_table_id "Мои реквизиты" "TABLE_MY_DETAILS"

echo ""
echo -e "${GREEN}✅ ID таблиц найдены${NC}"
echo ""

# ============================================
# ШАГ 6: Запуск через Docker Compose
# ============================================
echo -e "${BLUE} Шаг 6/6: Запуск контейнеров...${NC}"

docker compose up -d --build

echo -e "${GREEN}✅ Контейнеры запущены${NC}"
echo ""

# ============================================
# Проверка что всё работает
# ============================================
echo -e "${BLUE}🔍 Проверка работы...${NC}"

sleep 5

# Проверяем бота
if docker compose ps bot | grep -q "Up"; then
    echo -e "${GREEN}✅ Бот работает${NC}"
else
    echo -e "${RED}❌ Бот не запустился! Смотри логи: docker compose logs bot${NC}"
fi

# Проверяем вебхук
if docker compose ps webhook | grep -q "Up"; then
    echo -e "${GREEN}✅ Вебхук работает${NC}"
else
    echo -e "${RED}❌ Вебхук не запустился! Смотри логи: docker compose logs webhook${NC}"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}║   🎉 Установка завершена!                                 ║${NC}"
echo -e "${GREEN}║                                                           ║${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE} Полезные команды:${NC}"
echo "   docker compose logs -f        # Смотреть логи"
echo "   docker compose restart        # Перезапустить"
echo "   docker compose down           # Остановить"
echo ""
echo -e "${BLUE}🔗 Репозиторий: https://github.com/autarkea/printed4u-crm${NC}"
echo ""
