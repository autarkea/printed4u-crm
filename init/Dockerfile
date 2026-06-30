FROM node:18-alpine
WORKDIR /app
RUN npm install axios dotenv
COPY setup.js .
CMD ["node", "setup.js"]
