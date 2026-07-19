FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

RUN mkdir -p /app/config /data/vault \
    && chown -R node:node /app/config /data/vault

ENV NODE_ENV=production \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000 \
    AGENT_MEMORY_CONFIG=/app/config/config.json \
    AGENT_MEMORY_VAULT=/data/vault

USER node

EXPOSE 3000

CMD ["node", "src/mcp/main.ts"]
