import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

idx = html.find('makeSubscriptionPayment:An+"makeSubscriptionPayment"')
if idx != -1:
    matches = list(re.finditer(r'An\s*=\s*["\']([^"\']+)["\']', html[:idx]))
    if matches:
        print("An is:", matches[-1].group(0))
    else:
        # Search backwards 500 chars for An=
        print("Surrounding:", html[idx-300:idx])
