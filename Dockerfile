FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码与入口
COPY src/ ./src/
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=8080
ENV ROUTE_PREFIX=/coral
ENV DATA_DIR=/app/data

# 预置数据持久化挂载目录
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "src/server.js"]
