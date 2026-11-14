#!/bin/bash
LOG="/tmp/test_konnect.log"
echo "=== TEST KONNECT START ===" > "$LOG"
date >> "$LOG"

# Failsafe watchdog: if Raeith1 is not restored and no internet in 45s, restore Raeith1
(
  sleep 45
  if ! ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
    logger -t konnect-test "Watchdog: No internet, reverting to Raeith1"
    nmcli connection up Raeith1
  fi
) &
WATCHDOG_PID=$!

echo "[1] Activating KONNECT..." >> "$LOG"
nmcli connection up KONNECT >> "$LOG" 2>&1

echo "[2] Interface IP:" >> "$LOG"
ip addr show wlo1 >> "$LOG"

echo "[3] Gateway ping:" >> "$LOG"
ping -c 2 -W 2 10.16.0.1 >> "$LOG" 2>&1

echo "[4] Captive Portal probe (neverssl.com):" >> "$LOG"
curl -Iv -m 5 http://neverssl.com >> "$LOG" 2>&1

echo "[5] Captive Portal probe (10.16.0.1):" >> "$LOG"
curl -Iv -m 5 http://10.16.0.1 >> "$LOG" 2>&1

echo "[6] Internet ping (8.8.8.8):" >> "$LOG"
if ping -c 2 -W 2 8.8.8.8 >> "$LOG" 2>&1; then
  echo "SUCCESS: Internet is open on KONNECT!" >> "$LOG"
  kill $WATCHDOG_PID 2>/dev/null
else
  echo "FAIL: No internet on KONNECT, reverting to Raeith1..." >> "$LOG"
  nmcli connection up Raeith1 >> "$LOG" 2>&1
  kill $WATCHDOG_PID 2>/dev/null
fi

echo "=== TEST KONNECT FINISHED ===" >> "$LOG"
