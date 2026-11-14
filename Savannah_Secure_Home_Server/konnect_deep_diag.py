import subprocess
import time
import socket
import urllib.request
import ssl

LOG_FILE = "/tmp/konnect_deep_diag.log"

def log(msg):
    with open(LOG_FILE, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    print(msg)

with open(LOG_FILE, "w") as f:
    f.write("=== KONNECT DEEP DIAGNOSTIC START ===\n")

log("[1] Switching to KONNECT...")
subprocess.run(["nmcli", "connection", "up", "KONNECT"], capture_output=True, text=True)
time.sleep(3)

log("[2] Network state:")
ip_out = subprocess.check_output(["ip", "addr", "show", "wlo1"], text=True)
log(ip_out)
route_out = subprocess.check_output(["ip", "route"], text=True)
log(route_out)

log("[3] Testing Gateway Ping (10.16.0.1)...")
ret = subprocess.run(["ping", "-c", "2", "-W", "2", "10.16.0.1"], capture_output=True, text=True)
log(f"Gateway ping return: {ret.returncode}\n{ret.stdout}")

log("[4] Testing External Ping (8.8.8.8)...")
ret = subprocess.run(["ping", "-c", "2", "-W", "2", "8.8.8.8"], capture_output=True, text=True)
log(f"8.8.8.8 ping return: {ret.returncode}\n{ret.stdout}")

log("[5] Testing Path MTU to 8.8.8.8...")
for mtu in [1500, 1420, 1380, 1280]:
    payload_size = mtu - 28 # IP(20) + ICMP(8)
    ret = subprocess.run(["ping", "-c", "1", "-M", "do", "-s", str(payload_size), "8.8.8.8"], capture_output=True, text=True)
    log(f"MTU {mtu} (size {payload_size}): {'PASS' if ret.returncode == 0 else 'FAIL'}")

log("[6] Testing DNS resolution...")
for server in ["10.16.0.1", "8.8.8.8", "1.1.1.1"]:
    ret = subprocess.run(["dig", "+time=2", "+tries=1", f"@{server}", "controlplane.tailscale.com", "+short"], capture_output=True, text=True)
    log(f"DNS via {server}: {ret.stdout.strip() or 'FAILED/TIMEOUT'}")

log("[7] Testing HTTP port 80 (neverssl.com)...")
try:
    s = socket.create_connection(("neverssl.com", 80), timeout=3)
    s.sendall(b"HEAD / HTTP/1.1\r\nHost: neverssl.com\r\nConnection: close\r\n\r\n")
    resp = s.recv(512).decode("latin-1", errors="ignore")
    log(f"HTTP Port 80 response:\n{resp[:200]}")
    s.close()
except Exception as e:
    log(f"HTTP Port 80 failed: {e}")

log("[8] Testing HTTPS port 443 (controlplane.tailscale.com)...")
try:
    ctx = ssl.create_default_context()
    s = socket.create_connection(("controlplane.tailscale.com", 443), timeout=3)
    ss = ctx.wrap_socket(s, server_hostname="controlplane.tailscale.com")
    ss.sendall(b"HEAD / HTTP/1.1\r\nHost: controlplane.tailscale.com\r\nConnection: close\r\n\r\n")
    resp = ss.recv(512).decode("latin-1", errors="ignore")
    log(f"HTTPS Port 443 response:\n{resp[:200]}")
    ss.close()
except Exception as e:
    log(f"HTTPS Port 443 failed: {e}")

log("[9] Automatically reverting to Raeith1 to preserve SSH...")
subprocess.run(["nmcli", "connection", "up", "Raeith1"], capture_output=True, text=True)
time.sleep(2)
subprocess.run(["systemctl", "restart", "tailscaled"], capture_output=True, text=True)
log("=== FINISHED & REVERTED ===")
