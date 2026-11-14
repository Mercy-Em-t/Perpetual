import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

idx = html.find('this._global.authParams=')
if idx != -1:
    print(html[idx-100:idx+600])
else:
    idx2 = html.find('authParams={')
    if idx2 != -1:
        print(html[idx2-100:idx2+600])
    else:
        # Search for matches of authParams
        matches = [m.start() for m in re.finditer(r'authParams\s*[:=]', html)]
        for m in matches[:3]:
            print(html[m-50:m+300])
            print("="*40)
