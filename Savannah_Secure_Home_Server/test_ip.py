import subprocess
import time

subprocess.run(["nmcli", "connection", "up", "KONNECT"])
time.sleep(2)
try:
    ret = subprocess.run(["curl", "-k", "-I", "-m", "4", "https://192.200.0.106"], capture_output=True, text=True)
    with open("/tmp/direct_ip_test.log", "w") as f:
        f.write(f"ReturnCode: {ret.returncode}\nSTDOUT:\n{ret.stdout}\nSTDERR:\n{ret.stderr}\n")
finally:
    subprocess.run(["nmcli", "connection", "up", "Raeith1"])
    time.sleep(1)
    subprocess.run(["systemctl", "restart", "tailscaled"])
