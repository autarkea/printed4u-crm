#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM - Автоматическая установка             ║${NC}"
echo -e "${BLUE}║   Версия: 3.0.0 (NocoDB CE compatible)                ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "не определён")

if [[ "$LOCAL_IP" == "192.168."* ]] || [[ "$LOCAL_IP" == "10."* ]] || [[ "$LOCAL_IP" == "172."* ]]; then
    SERVER_TYPE="local"
    ACCESS_IP="$LOCAL_IP"
else
    SERVER_TYPE="vps"
    ACCESS_IP="$PUBLIC_IP"
fi

echo -e "${BLUE}🌐 Тип сервера: $SERVER_TYPE${NC}"
echo -e "${BLUE}📡 IP адрес: $ACCESS_IP${NC}"
echo ""

echo -e "${BLUE}📦 Шаг 1/7: Проверка и установка Docker...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠️  Docker не установлен. Устанавливаю...${NC}"
    curl -fsSL https://get.docker.com | bash
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✅ Docker установлен${NC}"
    echo -e "${YELLOW}⚠️  Перезайди в систему и запусти скрипт снова${NC}"
    exit 0
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
    sudo apt-get update
    sudo apt-get install -y git
    echo -e "${GREEN}✅ Git установлен${NC}"
fi

echo ""

echo -e "${BLUE}📁 Шаг 2/7: Создание папок...${NC}"

DATA_DIR="/mnt/data"
sudo mkdir -p $DATA_DIR/projects
sudo mkdir -p $DATA_DIR/clients
sudo mkdir -p $DATA_DIR/noco-static/pdfs
sudo mkdir -p $DATA_DIR/backups
sudo mkdir -p $DATA_DIR/nocodb-data
sudo chown -R $USER:$USER $DATA_DIR

echo -e "${GREEN}✅ Папки созданы${NC}"
echo ""

echo -e "${BLUE}📦 Шаг 2.5/7: Проверка шаблона базы данных...${NC}"
if [ ! -f "template.db" ]; then
    echo -e "${RED}❌ Файл template.db не найден!${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Шаблон найден (будет применён после создания базы)${NC}"
echo ""

echo -e "${BLUE}📥 Шаг 3/7: Скачивание кода с GitHub...${NC}"

INSTALL_DIR="/opt/printed4u-crm"

if [ -d "$INSTALL_DIR" ]; then
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

echo -e "${BLUE}⚙️  Шаг 4/7: Настройка конфигурации...${NC}"

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
    sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$bot_token|" .env
fi

read -p "Telegram User ID: " user_id
if [ ! -z "$user_id" ]; then
    sed -i "s|TELEGRAM_USER_ID=.*|TELEGRAM_USER_ID=$user_id|" .env
fi

read -p "SMTP Host: " smtp_host
if [ ! -z "$smtp_host" ]; then
    sed -i "s|SMTP_HOST=.*|SMTP_HOST=$smtp_host|" .env
fi

read -p "SMTP User: " smtp_user
if [ ! -z "$smtp_user" ]; then
    sed -i "s|SMTP_USER=.*|SMTP_USER=$smtp_user|" .env
fi

read -p "SMTP Password: " smtp_pass
if [ ! -z "$smtp_pass" ]; then
    sed -i "s|SMTP_PASS=.*|SMTP_PASS=$smtp_pass|" .env
fi

read -p "Webhook Secret: " webhook_secret
if [ ! -z "$webhook_secret" ]; then
    sed -i "s|WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$webhook_secret|" .env
fi

JWT_SECRET=$(openssl rand -base64 32)
sed -i "s|JWT_SECRET=.*|JWT_SECRET=$JWT_SECRET|" .env

echo -e "${GREEN}✅ .env настроен${NC}"
echo ""

echo -e "${BLUE}🐳 Шаг 5/7: Запуск контейнеров (это займёт 5-10 минут)...${NC}"

docker compose up -d --build

echo -e "${GREEN}✅ Контейнеры запущены${NC}"
echo ""

echo -e "${BLUE}⏳ Шаг 6/7: Ожидание запуска NocoDB...${NC}"
sleep 15

echo -e "${BLUE}🔧 Шаг 7/7: Настройка NocoDB...${NC}"
echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}⚠️  ВАЖНО! Выполни 3 шага в браузере:${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}1. Открой: http://$ACCESS_IP:8081${NC}"
echo -e "${YELLOW}2. Зарегистрируйся (создай аккаунт)${NC}"
echo -e "${YELLOW}3. СОЗДАЙ НОВУЮ БАЗУ (кнопка 'New base' → назови 'temp')${NC}"
echo -e "${YELLOW}   ⚡ Без этого шага workspace не создастся!${NC}"
echo -e "${YELLOW}4. Скопируй API Token (Settings → API Tokens → New Token)${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo ""
read -p "Когда создашь базу и скопируешь токен, нажми Enter..."

read -p "Вставь NocoDB API Token: " noco_token
if [ ! -z "$noco_token" ]; then
    sed -i "s|NOCO_TOKEN=.*|NOCO_TOKEN=$noco_token|" .env
fi

sed -i "s|NOCO_URL=.*|NOCO_URL=http://nocodb:8080|" .env

echo -e "${GREEN}✅ Токен сохранён${NC}"
echo ""

echo -e "${BLUE}🔄 Останавливаю NocoDB для применения шаблона...${NC}"
docker compose stop nocodb
sleep 3

echo -e "${BLUE}📦 Применяю шаблон базы данных...${NC}"
bash apply-template.sh

echo -e "${BLUE}🚀 Запускаю NocoDB...${NC}"
docker compose start nocodb
sleep 15

# Автоматически устанавливаем BASE_ID
echo -e "${BLUE}🔧 Устанавливаю BASE_ID...${NC}"
BASE_ID=$(docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
    apk add --no-cache sqlite >/dev/null 2>&1
    sqlite3 /data/noco.db "SELECT id FROM nc_bases_v2 WHERE title='"'"'CRM'"'"' LIMIT 1;"
')
if [ ! -z "$BASE_ID" ]; then
    sed -i "s|BASE_ID=.*|BASE_ID=$BASE_ID|" .env
    echo -e "${GREEN}✅ BASE_ID установлен: $BASE_ID${NC}"
else
    echo -e "${YELLOW}⚠️  База CRM не найдена, установи BASE_ID вручную${NC}"
fi

echo ""
echo -e "${GREEN}✅ NocoDB настроен с готовым шаблоном${NC}"
echo -e "${YELLOW}   Все таблицы уже созданы: Дела, Контакты, Проекты, Документы, Позиции заказа, Юрлица, Мои реквизиты${NC}"
echo ""

echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🎉 Установка завершена!                                 ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}🌐 Доступ к системе:${NC}"
echo "   NocoDB: http://$ACCESS_IP:8081"
echo "   Бот:    http://$ACCESS_IP:3000"
echo "   Webhook: http://$ACCESS_IP:3001"
echo ""
echo -e "${BLUE}📋 Полезные команды:${NC}"
echo "  cd /opt/printed4u-crm"
echo "  docker compose logs -f    # Логи"
echo "  docker compose restart    # Перезапуск"
echo "  docker compose down       # Остановить"
echo ""
