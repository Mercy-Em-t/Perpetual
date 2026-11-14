#!/usr/bin/env python3
import subprocess
import json
import urllib.request
import urllib.error
import sys
import os

PAVILION_IP = "100.73.175.118"
SSH_KEY = os.path.expanduser(r"~/.ssh/id_ed25519")
CLOUDFLARE_URL = "https://wa.missperpetual.cloud/health"
LOCAL_URL = f"http://{PAVILION_IP}:5174/health"

def run_ssh(cmd):
    try:
        res = subprocess.run(
            ["ssh", "-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=no", f"root@{PAVILION_IP}", cmd],
            capture_output=True, text=True, timeout=8
        )
        return res.returncode == 0, res.stdout.strip(), res.stderr.strip()
    except Exception as e:
        return False, "", str(e)

def check_http(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'SavannahMonitor/1.0'})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = resp.read().decode('utf-8')
            return resp.status == 200, json.loads(data)
    except Exception as e:
        return False, str(e)

def ping_host():
    try:
        # Windows ping
        res = subprocess.run(["ping", "-n", "2", "-w", "1000", PAVILION_IP], capture_output=True, text=True)
        return res.returncode == 0
    except Exception:
        return False

def audit_pavilion():
    report = {
        "network": {},
        "power_and_hardware": {},
        "system_resilience": {},
        "services": {},
        "overall_status": "UNKNOWN"
    }

    print("=================================================================")
    print("        PAVILION EDGE SERVER RESILIENCE & HEALTH AUDIT           ")
    print("=================================================================")

    # 1. Network Ping
    ping_ok = ping_host()
    report["network"]["tailscale_ping"] = "OK" if ping_ok else "FAILED"
    print(f"[*] Tailscale Mesh Ping ({PAVILION_IP}): {'PASS' if ping_ok else 'FAIL'}")

    # 2. Local HTTP Endpoint
    local_http_ok, local_data = check_http(LOCAL_URL)
    report["services"]["local_whatsapp_http"] = "UP" if local_http_ok else "DOWN"
    print(f"[*] Local WhatsApp Daemon Health ({LOCAL_URL}): {'PASS' if local_http_ok else 'FAIL'}")

    # 3. Cloudflare Tunnel HTTP Endpoint
    cf_http_ok, cf_data = check_http(CLOUDFLARE_URL)
    report["services"]["cloudflare_tunnel_http"] = "UP" if cf_http_ok else "DOWN"
    print(f"[*] Public Cloudflare Tunnel ({CLOUDFLARE_URL}): {'PASS' if cf_http_ok else 'FAIL'}")

    # 4. SSH Diagnostics
    ssh_ok, ssh_out, ssh_err = run_ssh(
        "cat /sys/class/power_supply/ADP1/online 2>/dev/null; "
        "cat /sys/class/power_supply/BAT0/capacity 2>/dev/null; "
        "grep -E '^HandleLidSwitch=' /etc/systemd/logind.conf; "
        "systemctl is-enabled sleep.target suspend.target; "
        "systemctl is-enabled docker tailscaled cloudflared; "
        "docker inspect savannah-whatsapp-daemon --format '{{.HostConfig.RestartPolicy.Name}}|{{.State.Status}}|{{.State.Health.Status}}'; "
        "free -m | awk 'NR==2{print $7} NR==3{print $4}'; "
        "uptime"
    )

    if not ssh_ok:
        print(f"[!] SSH query failed: {ssh_err}")
        report["system_resilience"]["ssh_access"] = "FAILED"
    else:
        report["system_resilience"]["ssh_access"] = "OK"
        lines = [l.strip() for l in ssh_out.splitlines() if l.strip()]
        # parse outputs
        # 1. ac online
        ac_online = lines[0] if len(lines) > 0 else "unknown"
        # 2. bat capacity
        bat_capacity = lines[1] if len(lines) > 1 else "unknown"
        # 3. lid switch
        lid_setting = lines[2] if len(lines) > 2 else "unknown"
        # 4. sleep & suspend
        sleep_targets = lines[3:5] if len(lines) > 4 else []
        # 5. docker, tailscaled, cloudflared
        sys_services = lines[5:8] if len(lines) > 7 else []
        
        # docker inspect
        docker_info = ""
        for line in lines:
            if "|" in line:
                docker_info = line
                break
        
        # memory
        free_ram = lines[-3] if len(lines) >= 3 else "unknown"
        free_swap = lines[-2] if len(lines) >= 2 else "unknown"
        uptime_str = lines[-1] if len(lines) >= 1 else "unknown"

        report["power_and_hardware"]["ac_power_connected"] = (ac_online == "1")
        report["power_and_hardware"]["battery_percentage"] = f"{bat_capacity}%"
        report["power_and_hardware"]["lid_close_behavior"] = lid_setting
        report["system_resilience"]["sleep_and_suspend_masked"] = all("masked" in s for s in sleep_targets)
        report["system_resilience"]["services_enabled_on_boot"] = sys_services
        report["system_resilience"]["container_status"] = docker_info
        report["system_resilience"]["available_ram_mb"] = free_ram
        report["system_resilience"]["available_swap_mb"] = free_swap
        report["system_resilience"]["uptime"] = uptime_str

        print(f"[*] AC Power Connected: {'YES (Mains Online)' if ac_online == '1' else 'NO'}")
        print(f"[*] Battery Level (Built-in UPS): {bat_capacity}%")
        print(f"[*] Lid Close Behavior: {lid_setting}")
        print(f"[*] Sleep / Suspend Targets Masked: {'YES (Cannot accidentally suspend)' if all('masked' in s for s in sleep_targets) else 'NO'}")
        print(f"[*] Container Policy & Status: {docker_info}")
        print(f"[*] Available Memory: {free_ram} MB RAM | {free_swap} MB Swap")
        print(f"[*] System Uptime: {uptime_str}")

    all_critical_pass = (
        ping_ok and
        local_http_ok and
        report["power_and_hardware"].get("ac_power_connected", False) and
        "unless-stopped" in report["system_resilience"].get("container_status", "") and
        report["system_resilience"].get("sleep_and_suspend_masked", False)
    )

    report["overall_status"] = "CERTIFIED_RESILIENT" if all_critical_pass else "NEEDS_ATTENTION"
    print("-----------------------------------------------------------------")
    print(f"STATUS VERDICT: {report['overall_status']}")
    print("=================================================================")
    return report

if __name__ == "__main__":
    audit_pavilion()
