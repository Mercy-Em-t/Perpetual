#!/usr/bin/env python3
"""
Namecheap Automated Dynamic DNS (DDNS) Updater
Updates missperpetual.cloud root and wildcard subdomains automatically.
"""
import urllib.request
import urllib.error
import re
import sys

DOMAIN = "missperpetual.cloud"
PASSWORD = "c99328dd3e974703b82ff2393cd952b4"
HOSTS = ["@", "*"]

def get_public_ip():
    providers = [
        "https://api.ipify.org",
        "https://icanhazip.com",
        "https://ifconfig.me/ip"
    ]
    for url in providers:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "curl/7.68.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                ip = resp.read().decode("utf-8").strip()
                if re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", ip):
                    return ip
        except Exception:
            continue
    return None

def update_ddns(host, domain, password, ip=None):
    base_url = f"https://dynamicdns.park-your-domain.com/update?host={host}&domain={domain}&password={password}"
    if ip:
        base_url += f"&ip={ip}"
    try:
        req = urllib.request.Request(base_url, headers={"User-Agent": "PerpetualDDNS/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8")
            err_count = re.search(r"<ErrCount>(\d+)</ErrCount>", content)
            if err_count and err_count.group(1) == "0":
                return True, "Success: DNS updated to " + (ip or "Auto-detected IP")
            else:
                err_msg = re.search(r"<Err1>(.*?)</Err1>", content)
                return False, err_msg.group(1) if err_msg else "Unknown DDNS error"
    except Exception as e:
        return False, str(e)

def main():
    print("==================================================")
    print("  PERPETUAL CLUSTER: NAMECHEAP DDNS SYNCHRONIZER  ")
    print("  Domain:", DOMAIN)
    print("==================================================")

    ip = get_public_ip()
    print("[*] Detected Public IP:", ip or "Will rely on Namecheap Auto-Detect")

    success_all = True
    for h in HOSTS:
        ok, msg = update_ddns(h, DOMAIN, PASSWORD, ip)
        status = "OK" if ok else "WARN"
        print(f"[{status}] Host '{h}.{DOMAIN}': {msg}")
        if not ok:
            success_all = False

    return 0 if success_all else 1

if __name__ == "__main__":
    sys.exit(main())
