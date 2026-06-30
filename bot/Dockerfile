FROM node:18-slim

# Устанавливаем зависимости для Puppeteer и rclone
RUN apt-get update && apt-get install -y \
    rclone \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Устанавливаем рабочую директорию
WORKDIR /app

# Копируем package.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем исходный код (только то, что реально есть!)
COPY server.js bot.js config.js ./

# Копируем шаблоны
COPY ../templates /app/templates

# Создаём папку для данных
RUN mkdir -p /mnt/data/noco-static/pdfs

# Открываем порт
EXPOSE 3000

# Запускаем бот
CMD ["node", "bot.js"]
