#!/usr/bin/env python3
"""
konnect_auto_auth.py
====================
Autonomous SasaKonnect / Ahadi Wireless Captive Portal Authenticator for Pavilion Server.
Detects Huawei / Ruckus AC HTML meta-refresh captive portal redirection,
extracts deviceip, userip, sysname, uservlan, usermac,
authenticates via https://api.sasakonnect.net/webPortalAuthAttempt with valid Basic Auth,
hits http://karibu.sasakonnect.net/ to finalize, and confirms internet connectivity.
Restarts tailscaled upon successful connection.
"""
import urllib.request
import urllib.parse
import base64
import json
import re
import sys
import subprocess
import time

def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)

def verify_google_https():
    """Verify true outbound HTTPS connectivity to Google."""
    try:
        res = subprocess.run(
            ["curl", "-s", "-I", "-m", "5", "https://www.google.com"],
            capture_output=True,
            text=True
        )
        if "HTTP/2 200" in res.stdout or "HTTP/1.1 200" in res.stdout or "HTTP/2 301" in res.stdout or "HTTP/2 302" in res.stdout:
            return True
    except Exception:
        pass
    return False

def authenticate_konnect():
    log("[1] Checking current IP on wlo1...")
    sta_ip = "10.16.1.172"
    try:
        ip_out = subprocess.check_output(["ip", "-4", "addr", "show", "dev", "wlo1"], text=True)
        m_ip = re.search(r'inet\s+(\d+\.\d+\.\d+\.\d+)', ip_out)
        if m_ip:
            sta_ip = m_ip.group(1)
        log(f"    Current wlo1 IP: {sta_ip}")
    except Exception as e:
        log(f"    Could not read wlo1 IP: {e}")

    log("[2] Probing for SasaKonnect captive portal redirect...")
    try:
        probe = subprocess.check_output(
            ["curl", "-s", "-i", "-m", "5", "http://connectivitycheck.gstatic.com/generate_204"],
            text=True
        )
    except Exception as e:
        log(f"[-] Probe error: {e}")
        probe = ""

    match = re.search(r'URL=([^\'">\s]+)', probe, re.IGNORECASE)
    if match:
        redir_url = match.group(1)
        log(f"[3] Captured Portal Redirect URL:\n    {redir_url}")
        parsed = urllib.parse.urlparse(redir_url)
        qs = urllib.parse.parse_qs(parsed.query)
        deviceip = qs.get("deviceip", ["10.125.0.253"])[0]
        staIp = qs.get("userip", qs.get("staIp", [sta_ip]))[0]
        sysname = qs.get("sysname", ["RMM125"])[0]
        vlan = qs.get("uservlan", qs.get("vlan", ["2016"]))[0]
        staMac = qs.get("usermac", qs.get("staMac", ["dc:f5:05:97:f6:09"]))[0]
    else:
        log("[3] No meta-refresh redirect found. Using AC defaults with current IP...")
        deviceip = "10.125.0.253"
        staIp = sta_ip
        sysname = "RMM125"
        vlan = "2016"
        staMac = "dc:f5:05:97:f6:09"

    payload = {
        "deviceip": deviceip,
        "staIp": staIp,
        "sysname": sysname,
        "vlan": vlan,
        "staMac": staMac,
        "konnecter": "unknown",
        "token": "unknown"
    }
    log(f"[4] Submitting auth payload:\n{json.dumps(payload, indent=2)}")

    api_url = "https://api.sasakonnect.net/webPortalAuthAttempt"
    data = urllib.parse.urlencode(payload).encode("utf-8")
    b_auth = base64.b64encode(b"$2a$10$LaAh5xhco:Z0hKJx5RvyleG4HpvD7").decode("ascii")

    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": f"Basic {b_auth}",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
        "Origin": "https://portal.sasakonnect.net",
        "Referer": "https://portal.sasakonnect.net/"
    }

    phone_num = ""
    req = urllib.request.Request(api_url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read().decode("utf-8")
            log(f"[5] API Response ({r.status}): {body}")
            res_json = json.loads(body)
            if res_json.get("success") == "true":
                log("[SUCCESS] SasaKonnect verified active subscription!")
                phone_num = res_json.get("payload", {}).get("phone", "")
            else:
                log(f"[-] API returned non-success: {res_json}")
    except Exception as e:
        log(f"[-] API submission failed: {e}")

    # Finalize redirect to trigger router session unlock
    log("[6] Hitting router unlock landing pages...")
    try:
        subprocess.run(["curl", "-s", "-m", "4", "http://karibu.sasakonnect.net/"], capture_output=True)
        if phone_num:
            subprocess.run(["curl", "-s", "-m", "4", f"http://karibu.sasakonnect.net/spinthewheel?phone={urllib.parse.quote(phone_num)}"], capture_output=True)
    except Exception as e:
        log(f"[-] Landing page curl error: {e}")

    time.sleep(3)

    # Verify live internet access
    log("[7] Verifying live Google HTTPS connectivity...")
    for attempt in range(1, 8):
        if verify_google_https():
            log(f"[SUCCESS] Live HTTPS internet confirmed open on KONNECT (attempt {attempt})!")
            return True
        time.sleep(2)

    log("[-] Google HTTPS check failed after attempts.")
    return False

def main():
    ok = authenticate_konnect()
    if ok:
        log("[DONE] Captive portal authentication complete. Restarting Tailscale...")
        subprocess.run(["systemctl", "restart", "tailscaled"])
        time.sleep(3)
        sys.exit(0)
    else:
        log("[-] Captive portal authentication did not open live HTTPS.")
        sys.exit(1)

if __name__ == "__main__":
    main()
