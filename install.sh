#!/bin/bash

# ============================================
# Printed4U CRM - Автоматический установщик
# Версия: 1.1.0 (с NocoDB + SQLite)
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM - Автоматическая установка             ║${NC}"
echo -e "${BLUE}║   Версия: 1.1.0 (с NocoDB + SQLite)                     ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================
# ШАГ 1: Установка Docker (если нет)
# ============================================
echo -e "${BLUE}📦 Шаг 1/6: Проверка и установка Docker...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠️  Docker не установлен. Устанавливаю...${NC}"
    echo ""
    
    # Устанавливаем Docker официальным способом
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    
    # Добавляем пользователя в группу docker
    sudo usermod -aG docker $USER
    
    echo ""
    echo -e "${GREEN}✅ Docker установлен${NC}"
    echo -e "${YELLOW}⚠️  Применяю изменения группы...${NC}"
    
    # Пробуем применить группу без перелогина
    newgrp docker << 'ENDSCRIPT'
    echo "Группа docker применена"
ENDSCRIPT
    
    # Проверяем, работает ли docker
    if ! docker ps &> /dev/null; then
        echo -e "${YELLOW}⚠️  Требуется перезапуск сессии${NC}"
        echo -e "${YELLOW}   Закрой терминал и открой снова, затем запусти скрипт повторно${NC}"
        exit 0
    fi
else
    echo -e "${GREEN}✅ Docker: $(docker --version)${NC}"
fi

if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose не установлен${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Docker Compose: $(docker compose version)${NC}"
fi

if ! command -v git &> /dev/null; then
    echo -e "${YELLOW}⚠️  Git не установлен. Устанавливаю...${NC}"
    sudo apt-get update
    sudo apt-get install -y git
    echo -e "${GREEN}✅ Git установлен${NC}"
else
    echo -e "${GREEN}✅ Git найден${NC}"
fi

echo ""

# ============================================
# ШАГ 2: Создание папок
# ============================================
echo -e "${BLUE}📁 Шаг 2/6: Создание папок...${NC}"

DATA_DIR="/mnt/data"
sudo mkdir -p $DATA_DIR/projects
sudo mkdir -p $DATA_DIR/clients
sudo mkdir -p $DATA_DIR/noco-static/pdfs
sudo mkdir -p $DATA_DIR/backups
sudo mkdir -p $DATA_DIR/nocodb
sudo chown -R $USER:$USER $DATA_DIR

echo -e "${GREEN}✅ Папки созданы${NC}"
echo ""

# ============================================
# ШАГ 3: Скачивание кода
# ============================================
echo -e "${BLUE}📥 Шаг 3/6: Скачивание кода с GitHub...${NC}"

INSTALL_DIR="/opt/printed4u-crm"

if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}⚠️  Папка уже существует${NC}"
    sudo chown -R $USER:$USER $INSTALL_DIR
    cd $INSTALL_DIR
    git pull origin main
    echo -e "${GREEN}✅ Код обновлён${NC}"
else
    cd /opt
    sudo git clone https://github.com/autarkea/printed4u-crm.git
    sudo chown -R $USER:$USER printed4u-crm
    cd printed4u-crm
    echo -e "${GREEN}✅ Код скачан${NC}"
fi

echo ""

# ============================================
# ШАГ 4: Создание .env
# ============================================
echo -e "${BLUE}⚙️  Шаг 4/6: Настройка конфигурации...${NC}"

ENV_FILE="$INSTALL_DIR/.env"

if [ -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}⚠️  .env уже существует${NC}"
    read -p "Перезаписать? (y/N): " answer
    if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        cp .env.example .env
    fi
else
    cp .env.example .env
fi

echo ""
echo -e "${YELLOW}Заполни данные (Enter = пропустить):${NC}"
echo ""

read -p "Telegram Bot Token: " bot_token
if [ ! -z "$bot_token" ]; then
    sed -i "s/TELEGRAM_BOT_TOKEN=.*/TELEGRAM_BOT_TOKEN=$bot_token/" .env
fi

read -p "Telegram User ID: " user_id
if [ ! -z "$user_id" ]; then
    sed -i "s/TELEGRAM_USER_ID=.*/TELEGRAM_USER_ID=$user_id/" .env
fi

read -p "NocoDB API Token: " noco_token
if [ ! -z "$noco_token" ]; then
    sed -i "s/NOCO_TOKEN=.*/NOCO_TOKEN=$noco_token/" .env
fi

read -p "NocoDB Base ID: " base_id
if [ ! -z "$base_id" ]; then
    sed -i "s/BASE_ID=.*/BASE_ID=$base_id/" .env
fi

read -p "SMTP Host: " smtp_host
if [ ! -z "$smtp_host" ]; then
    sed -i "s/SMTP_HOST=.*/SMTP_HOST=$smtp_host/" .env
fi

read -p "SMTP User: " smtp_user
if [ ! -z "$smtp_user" ]; then
    sed -i "s/SMTP_USER=.*/SMTP_USER=$smtp_user/" .env
fi

read -p "SMTP Password: " smtp_pass
if [ ! -z "$smtp_pass" ]; then
    sed -i "s/SMTP_PASS=.*/SMTP_PASS=$smtp_pass/" .env
fi

read -p "Webhook Secret: " webhook_secret
if [ ! -z "$webhook_secret" ]; then
    sed -i "s/WEBHOOK_SECRET=.*/WEBHOOK_SECRET=$webhook_secret/" .env
fi

# Генерируем JWT_SECRET для NocoDB
JWT_SECRET=$(openssl rand -base64 32)
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env

echo -e "${GREEN}✅ .env настроен${NC}"
echo ""

# ============================================
# ШАГ 5: Запуск контейнеров
# ============================================
echo -e "${BLUE}🐳 Шаг 5/6: Запуск контейнеров (это займёт 5-10 минут)...${NC}"

docker compose up -d --build

echo -e "${GREEN}✅ Контейнеры запущены${NC}"
echo ""

# ============================================
# ШАГ 6: Проверка
# ============================================
echo -e "${BLUE}🔍 Шаг 6/6: Проверка работы...${NC}"

sleep 10

# Проверяем NocoDB
if docker compose ps nocodb | grep -q "Up"; then
    echo -e "${GREEN}✅ NocoDB работает${NC}"
    echo -e "${YELLOW}   Открой: http://localhost:8081${NC}"
else
    echo -e "${RED}❌ NocoDB не запустился${NC}"
fi

# Проверяем бота
if docker compose ps bot | grep -q "Up"; then
    echo -e "${GREEN}✅ Бот работает${NC}"
else
    echo -e "${RED}❌ Бот не запустился${NC}"
fi

# Проверяем вебхук
if docker compose ps webhook | grep -q "Up"; then
    echo -e "${GREEN}✅ Вебхук работает${NC}"
else
    echo -e "${RED}❌ Вебхук не запустился${NC}"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🎉 Установка завершена!                                 ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}Следующие шаги:${NC}"
echo "1. Открой http://localhost:8081"
echo "2. Создай аккаунт в NocoDB"
echo "3. Создай базу данных и таблицы"
echo "4. Скопируй API Token и Base ID"
echo "5. Отредактируй .env и добавь токены"
echo "6. Перезапусти: docker compose restart"
echo ""
echo -e "${BLUE}Полезные команды:${NC}"
echo "  cd /opt/printed4u-crm"
echo "  docker compose logs -f    # Логи"
echo "  docker compose restart    # Перезапуск"
echo "  docker compose down       # Остановить"
echo ""
