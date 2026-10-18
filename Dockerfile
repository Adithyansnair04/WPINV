# Long-running bot (Telegram polling by default). No inbound port is needed except the optional dashboard.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY data ./data
COPY eval ./eval
# Runtime state (dedupe, pending clarifications, activity, Baileys session if used) lives in a volume.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
ENV DATA_DIR=/app/.data \
    DASHBOARD_HOST=0.0.0.0
VOLUME ["/app/.data"]
EXPOSE 3001
# node as PID 1 so SIGTERM reaches the bot's graceful shutdown.
CMD ["node", "--import", "tsx", "src/index.ts"]
