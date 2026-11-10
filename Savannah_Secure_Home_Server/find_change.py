import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

idx = html.find('.changeDevice(')
if idx == -1:
    idx = html.find('changeDevice(')
if idx != -1:
    print(html[idx:idx+800])
else:
    # search for changeDevice
    matches = [m.start() for m in re.finditer(r'changeDevice', html)]
    for m in matches:
        print(html[m-50:m+250])
        print("="*40)
