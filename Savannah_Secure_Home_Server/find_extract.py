import urllib.request
import re

url = "https://portal.sasakonnect.net/main.e7da31c6e2d0399f.js"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req).read().decode("utf-8", errors="ignore")

idx = html.find('extractAuthFromUrl(){')
if idx == -1:
    idx = html.find('extractAuthFromUrl()')
print(html[idx:idx+1200])
