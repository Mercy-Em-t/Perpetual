#!/bin/bash
cd /home/mismercz/Perpetual || exit 1
git fetch origin main -q
LOCAL_HASH=$(git rev-parse HEAD)
REMOTE_HASH=$(git rev-parse origin/main)

if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
    echo "[SYNC $(date)] Detected new commit ($REMOTE_HASH). Pulling and syncing container..."
    git pull origin main -q
    docker cp /home/mismercz/Perpetual/whatsapp_gateway/. savannah-whatsapp-daemon:/app/gateway/
    docker restart savannah-whatsapp-daemon > /dev/null
    echo "[SYNC $(date)] Gateway synced and container reloaded."
fi
