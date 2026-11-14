import urllib.request
import urllib.parse
import base64
import json

payload = {
    "deviceip": "10.125.0.253",
    "staIp": "10.16.1.172",
    "sysname": "RMM125",
    "vlan": "2016",
    "staMac": "dc:f5:05:97:f6:09",
    "konnecter": "unknown",
    "token": "unknown"
}

url = "https://api.sasakonnect.net/webPortalAuthAttempt"
data = urllib.parse.urlencode(payload).encode("utf-8")

b_auth = base64.b64encode(b"$2a$10$LaAh5xhco:Z0hKJx5RvyleG4HpvD7").decode("ascii")

headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "Authorization": f"Basic {b_auth}",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)",
    "Origin": "https://portal.sasakonnect.net",
    "Referer": "https://portal.sasakonnect.net/"
}

req = urllib.request.Request(url, data=data, headers=headers)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        print(f"Status: {r.status}")
        body = r.read().decode("utf-8")
        print("Response:", body)
except Exception as e:
    print("Error:", e)
