import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

for term in ["supportTPAuth", "authParams", "login", "register", "connect"]:
    matches = [m.start() for m in re.finditer(re.escape(term), html)]
    print(f"=== Matches for {term} ({len(matches)}) ===")
    for idx in matches[:2]:
        snippet = html[max(0, idx-100):min(len(html), idx+300)]
        print(snippet)
        print("-" * 50)
