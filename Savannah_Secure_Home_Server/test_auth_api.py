import urllib.request
import json

payload = {
    "deviceip": "10.125.0.253",
    "staIp": "10.16.1.172",
    "sysname": "RMM125",
    "vlan": "2016",
    "staMac": "dc:f5:05:97:f6:09"
}

url = "https://api.sasakonnect.net/webPortalAuthAttempt"
data = json.dumps(payload).encode("utf-8")
headers = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
    "Origin": "https://portal.sasakonnect.net",
    "Referer": "https://portal.sasakonnect.net/"
}

req = urllib.request.Request(url, data=data, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"Status: {r.status}")
        print("Response:", r.read().decode("utf-8"))
except Exception as e:
    print("Error:", e)
