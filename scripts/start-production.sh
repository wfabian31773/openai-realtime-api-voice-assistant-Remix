#!/bin/bash
set -e

echo "[PRODUCTION] Starting Azul Vision AI Operations Hub..."

export APP_ENV=production
export NODE_ENV=production

export PORT=${PORT:-5000}
export DOMAIN=${DOMAIN:-localhost}

echo "[PRODUCTION] Environment: APP_ENV=$APP_ENV"
echo "[PRODUCTION] Port: $PORT"
echo "[PRODUCTION] Domain: $DOMAIN"

exec npx tsx server/productionServer.ts
