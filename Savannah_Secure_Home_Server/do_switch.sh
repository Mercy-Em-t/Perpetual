#!/bin/bash
exec >> /tmp/switch_live.log 2>&1
echo "=== Starting switch to KONNECT at $(date) ==="
nmcli connection up KONNECT
sleep 4
echo "Running konnect_auto_auth.py..."
python3 /usr/local/bin/konnect_auto_auth.py

echo "Testing final HTTPS connectivity..."
if ! curl -s -I -m 5 https://www.google.com >/dev/null 2>&1; then
    echo "Failed to get verified internet on KONNECT, falling back to Raeith1..."
    nmcli connection up Raeith1
else
    echo "KONNECT ONLINE AND CONFIRMED FUNCTIONAL!"
fi
echo "=== Finished switch script at $(date) ==="
