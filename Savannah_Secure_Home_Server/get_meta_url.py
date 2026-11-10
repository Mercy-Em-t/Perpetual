import subprocess
import time
import re

subprocess.run(["nmcli", "connection", "up", "KONNECT"])
time.sleep(3)

ret = subprocess.run(["curl", "-s", "-i", "-m", "3", "http://connectivitycheck.gstatic.com/generate_204"], capture_output=True, text=True)

with open("/tmp/full_redirect.html", "w") as f:
    f.write(ret.stdout)

# Extract URL from meta refresh
m = re.search(r'URL=([^\'">\s]+)', ret.stdout, re.IGNORECASE)
redir_url = m.group(1) if m else "NOT_FOUND"

with open("/tmp/redirect_url.txt", "w") as f:
    f.write(redir_url)

subprocess.run(["nmcli", "connection", "up", "Raeith1"])
time.sleep(1)
subprocess.run(["systemctl", "restart", "tailscaled"])
