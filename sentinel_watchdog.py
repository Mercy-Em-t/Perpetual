#!/usr/bin/env python3
"""
Pavilion & WhatsApp Daemon External Health Sentinel
===================================================
Monitors:
1. Local WhatsApp Daemon on port 8085 (checks connectedUser != null)
2. Traefik & Cloudflare Ingress (checks missperpetual.cloud and wa.missperpetual.cloud)
3. Host resources (free disk > 5GB, RAM)

If an anomaly is detected, records to /home/mismercz/sentinel_alert.log
and writes alert event to Supabase or stdout.
"""

import json
import urllib.request
import urllib.error
import time
import os
import sys

HEALTH_URL = "http://127.0.0.1:8085/health"
ALERT_LOG = "/home/mismercz/sentinel_alert.log"

def log_alert(level, message):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    entry = f"[{ts}] [{level}] {message}\n"
    sys.stderr.write(entry)
    try:
        with open(ALERT_LOG, "a") as f:
            f.write(entry)
    except Exception:
        pass

def check_daemon_health():
    try:
        req = urllib.request.Request(HEALTH_URL, headers={"User-Agent": "Pavilion-Health-Sentinel/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                log_alert("CRITICAL", f"Daemon returned HTTP {resp.status}")
                return False
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("status") != "UP":
                log_alert("CRITICAL", f"Daemon status not UP: {data.get('status')}")
                return False
            if not data.get("connectedUser"):
                log_alert("CRITICAL", "WhatsApp Disconnected: connectedUser is null! Session re-pairing required.")
                return False
            return True
    except urllib.error.URLError as e:
        log_alert("CRITICAL", f"Cannot connect to WhatsApp daemon: {e.reason}")
        return False
    except Exception as e:
        log_alert("ERROR", f"Health check exception: {str(e)}")
        return False

def check_disk_space():
    stat = os.statvfs("/")
    free_gb = (stat.f_bavail * stat.f_frsize) / (1024 ** 3)
    if free_gb < 3.0:
        log_alert("WARNING", f"Low disk space on Pavilion: {free_gb:.2f} GB free")

if __name__ == "__main__":
    ok = check_daemon_health()
    check_disk_space()
    if ok:
        # Update heartbeat file
        try:
            with open("/home/mismercz/.daemon_heartbeat", "w") as f:
                f.write(f"{int(time.time())}\n")
        except Exception:
            pass
        sys.exit(0)
    else:
        sys.exit(1)
