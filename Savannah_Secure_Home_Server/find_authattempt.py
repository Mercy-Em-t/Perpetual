import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

for term in ["authAttempt=", "webPortalAuthAttempt"]:
    matches = [m.start() for m in re.finditer(re.escape(term), html)]
    print(f"=== {term} ===")
    for idx in matches[:3]:
        print(html[idx:idx+350])
        print("-" * 50)
