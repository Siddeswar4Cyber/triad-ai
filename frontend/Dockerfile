FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src

CMD ["npm", "run", "dev"]