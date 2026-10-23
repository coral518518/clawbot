FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm install --omit=dev

# 复制源码与入口
COPY src/ ./src/
COPY server.js ./

ENV NODE_ENV=production
ENV PORT=5000
ENV ROUTE_PREFIX=/coral
ENV DATA_DIR=/app/data
# 针对 Miget Free Tier (256MB) 限制 V8 最大堆内存，防止启动瞬间 OOMKilled
ENV NODE_OPTIONS="--max-old-space-size=160"

# 预置数据持久化挂载目录并赋予完全读写权限（兼容非 root 容器运行环境）
RUN mkdir -p /app/data && chmod -R 777 /app/data

# Miget 统一由 Ingress 路由至 5000 端口
EXPOSE 5000

CMD ["node", "src/server.js"]
