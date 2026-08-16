FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    python3 \
    python3-pip \
    default-jdk-headless \
    git \
    ca-certificates \
    curl \
    coreutils \
    time \
    procps \
    iproute2 \
    iputils-ping \
    gnupg \
    tini && \
    install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list && \
    apt-get update && apt-get install -y --no-install-recommends docker-ce-cli && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /app/src/daemon

COPY src/daemon/package*.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

COPY src/daemon /app/src/daemon
COPY src/checkers /app/src/checkers
COPY config /app/config

EXPOSE 3001

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/src/daemon/index.js"]