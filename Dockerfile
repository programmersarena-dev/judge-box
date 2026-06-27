FROM node:18-bullseye

# Install tools and common compilers used by the platform
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ make python3 python3-pip default-jdk git ca-certificates curl coreutils \
    time procps iproute2 iputils-ping && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy daemon
COPY src/daemon /app/src/daemon
COPY src/checkers /app/src/checkers
COPY config /app/config

WORKDIR /app/src/daemon

RUN npm install --production

EXPOSE 3001

CMD ["node","index.js"]
