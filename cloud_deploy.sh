#!/usr/bin/env bash
# ==============================================================================
# PERPETUAL ONE — CLOUD BOOTSTRAPPER & JOURNEY LAUNCH SCRIPT
# ==============================================================================
set -euo pipefail

echo "============================================================"
echo "🚀 INITIATING PERPETUAL ONE CLOUD CONTAINERIZATION..."
echo "============================================================"

# Check for Docker and Docker Compose
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose plugin not found. Installing..."
    apt-get update && apt-get install -y docker-compose-plugin
fi

echo "📦 1. Preparing persistent storage directories..."
mkdir -p assets templates static docs config .auth_whatsapp_baileys

echo "🔨 2. Building cloud microservice images..."
docker compose build --no-cache

echo "🚀 3. Launching Perpetual One cluster in background..."
docker compose up -d

echo "⏳ 4. Waiting for health handshakes..."
sleep 5

echo "🔍 5. Verifying container health..."
docker compose ps

echo "🌐 6. Probing core endpoints..."
if curl -sf http://127.0.0.1:5050/api/health > /dev/null; then
    echo "✅ Room Server (:5050) is ONLINE and responding!"
else
    echo "⚠️ Room Server (:5050) did not respond yet. Checking logs:"
    docker compose logs room-server --tail 20
fi

if curl -sf http://127.0.0.1:5174/health > /dev/null; then
    echo "✅ WhatsApp Gateway (:5174) is ONLINE and responding!"
else
    echo "⚠️ WhatsApp Gateway (:5174) starting up. Checking logs:"
    docker compose logs whatsapp-gateway --tail 20
fi

echo "============================================================"
echo "🎉 PERPETUAL ONE HAS ARRIVED IN THE CLOUD!"
echo "• Core Dashboard:    http://<YOUR-SERVER-IP>:5050/room"
echo "• Storefront Portal: http://<YOUR-SERVER-IP>:5050/storefront"
echo "• WhatsApp Gateway:  http://<YOUR-SERVER-IP>:5174/health"
echo "============================================================"
