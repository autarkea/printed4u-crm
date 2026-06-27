FROM node:18-alpine

WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm ci --only=production

# Копируем код
COPY server.js ./

# Создаём директорию для проектов (будет монтироваться)
RUN mkdir -p /mnt/data/projects

# Открываем порт
EXPOSE 3001

# Запускаем
CMD ["node", "server.js"]
