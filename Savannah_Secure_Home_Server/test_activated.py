import subprocess
import time

LOG = "/tmp/konnect_activated_test.log"

def write_log(txt):
    with open(LOG, "a") as f:
        f.write(txt + "\n")
    print(txt)

with open(LOG, "w") as f:
    f.write("=== KONNECT ACTIVATED TEST START ===\n")

write_log("[1] Re-associating with KONNECT...")
subprocess.run(["nmcli", "connection", "up", "KONNECT"])
time.sleep(4)

write_log("[2] Interface IP:")
out = subprocess.check_output(["ip", "addr", "show", "wlo1"], text=True)
write_log(out)

write_log("[3] Testing ping 8.8.8.8...")
p = subprocess.run(["ping", "-c", "2", "-W", "2", "8.8.8.8"], capture_output=True, text=True)
write_log(f"Ping result ({p.returncode}):\n{p.stdout}")

write_log("[4] Testing TCP Port 443 to Tailscale controlplane (192.200.0.106)...")
c = subprocess.run(["curl", "-k", "-I", "-m", "4", "https://192.200.0.106"], capture_output=True, text=True)
write_log(f"Curl 443 result ({c.returncode}):\n{c.stdout}\n{c.stderr}")

write_log("[5] Testing DNS via 8.8.8.8 to controlplane.tailscale.com...")
d = subprocess.run(["dig", "+time=2", "+tries=1", "@8.8.8.8", "controlplane.tailscale.com", "+short"], capture_output=True, text=True)
write_log(f"DNS result:\n{d.stdout}")

if c.returncode == 0 or "HTTP/" in c.stdout or "HTTP/" in c.stderr:
    write_log("[SUCCESS] KONNECT IS FULLY UNBLOCKED AND ROUTING TCP 443!")
    subprocess.run(["systemctl", "restart", "tailscaled"])
    write_log("[DONE] Tailscale restarted over direct KONNECT!")
else:
    write_log("[-] Port 443 still not answering. Reverting to Raeith1...")
    subprocess.run(["nmcli", "connection", "up", "Raeith1"])
    time.sleep(2)
    subprocess.run(["systemctl", "restart", "tailscaled"])
