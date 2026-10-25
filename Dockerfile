FROM node:20-alpine

RUN apk add --no-cache \
    curl \
    docker-cli \
    tini

WORKDIR /app/src/daemon

COPY src/daemon/package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --no-fund

COPY src/daemon /app/src/daemon
COPY src/checkers /app/src/checkers
COPY config /app/config

EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/src/daemon/index.js"]
