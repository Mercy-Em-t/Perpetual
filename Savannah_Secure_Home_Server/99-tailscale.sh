#!/bin/bash
INTERFACE="$1"
ACTION="$2"

if [ "$INTERFACE" = "wlo1" ] && [ "$ACTION" = "up" ]; then
    logger -t nm-dispatcher "wlo1 came up. Running SasaKonnect auto-auth..."
    python3 /usr/local/bin/konnect_auto_auth.py >> /var/log/konnect_auto_auth.log 2>&1
fi
