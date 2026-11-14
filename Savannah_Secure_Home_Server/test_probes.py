import subprocess
import time

subprocess.run(["nmcli", "connection", "up", "KONNECT"])
time.sleep(3)

results = []
test_urls = [
    "http://connectivitycheck.gstatic.com/generate_204",
    "http://detectportal.firefox.com/canonical.html",
    "http://www.msftconnecttest.com/connecttest.txt",
    "http://10.16.0.1/",
    "http://10.16.0.1:8080/",
    "http://karibu.sasakonnect.net/"
]

for url in test_urls:
    try:
        ret = subprocess.run(["curl", "-s", "-i", "-m", "3", url], capture_output=True, text=True)
        results.append(f"=== URL: {url} (code {ret.returncode}) ===\n{ret.stdout[:300]}\n")
    except Exception as e:
        results.append(f"=== URL: {url} ERROR: {e} ===\n")

with open("/tmp/captive_probe_test.log", "w") as f:
    f.write("\n".join(results))

subprocess.run(["nmcli", "connection", "up", "Raeith1"])
time.sleep(1)
subprocess.run(["systemctl", "restart", "tailscaled"])
