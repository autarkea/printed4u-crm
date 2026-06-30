FROM node:18-slim

# Устанавливаем зависимости для Puppeteer и rclone
RUN apt-get update && apt-get install -y \
    rclone \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Копируем package.json из папки bot
COPY bot/package*.json ./

# Устанавливаем зависимости
RUN npm install --production

# Копируем исходники бота
COPY bot/server.js bot/bot.js bot/config.js ./

# Копируем шаблоны (теперь из корня проекта)
COPY templates /app/templates

# Создаём папку для данных
RUN mkdir -p /mnt/data/noco-static/pdfs

EXPOSE 3000

CMD ["node", "bot.js"]
