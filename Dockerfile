FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制源码
COPY src/ ./src/

ENV NODE_ENV=production
ENV PORT=8080
ENV DATA_DIR=/app/data

# 预置挂载目录
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "src/server.js"]
