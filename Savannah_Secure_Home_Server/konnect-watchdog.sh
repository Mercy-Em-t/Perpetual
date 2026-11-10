#!/bin/bash
# Konnect Captive Portal Watchdog & Self-Healer
# Check true HTTPS internet access rather than ICMP ping
if curl -s -I -m 4 https://www.google.com >/dev/null 2>&1; then
    exit 0
fi

logger -t konnect-watchdog "Internet/HTTPS blocked or down. Running SasaKonnect auto-auth..."
python3 /usr/local/bin/konnect_auto_auth.py >> /var/log/konnect_watchdog.log 2>&1
sleep 2

# If still not reachable, ensure KONNECT connection is up and retry
if ! curl -s -I -m 4 https://www.google.com >/dev/null 2>&1; then
    logger -t konnect-watchdog "Still blocked. Reactivating KONNECT and retrying auth..."
    nmcli connection up KONNECT >> /var/log/konnect_watchdog.log 2>&1
    sleep 3
    python3 /usr/local/bin/konnect_auto_auth.py >> /var/log/konnect_watchdog.log 2>&1
fi
