#!/usr/bin/env bash
# ==============================================================================
# Savannah Autonomous Secure Edge Home Server - Automated Bootstrap Script
# Target: Ubuntu Server 24.04 LTS (x86_64)
# ==============================================================================

set -euo pipefail

echo "======================================================================"
echo "SAVANNAH SECURE EDGE NODE: AUTOMATED BOOTSTRAP INSTALLER"
echo "======================================================================"

# 1. Update system packages
echo "[1/7] Updating Ubuntu base packages..."
sudo apt-get update && sudo apt-get upgrade -y

# 2. Configure TLP Battery Safety & Lid Sleep Masking
echo "[2/7] Configuring Battery Charge Limits & Thermal Chimney..."
sudo apt-get install -y tlp tlp-rdw dropbear-initramfs ufw curl
sudo sed -i 's/#START_CHARGE_THRESH_BAT0=75/START_CHARGE_THRESH_BAT0=50/g' /etc/tlp.conf || true
sudo sed -i 's/#STOP_CHARGE_THRESH_BAT0=80/STOP_CHARGE_THRESH_BAT0=60/g' /etc/tlp.conf || true
sudo tlp start || true

sudo sed -i 's/#HandleLidSwitch=suspend/HandleLidSwitch=ignore/g' /etc/systemd/logind.conf
sudo sed -i 's/#HandleLidSwitchDocked=suspend/HandleLidSwitchDocked=ignore/g' /etc/systemd/logind.conf
sudo systemctl restart systemd-logind

# 3. Configure Dropbear Initramfs Pre-Boot Remote Unlock
echo "[3/7] Setting up Dropbear Pre-Boot SSH Unlock on Port 2222..."
if [ -f "$HOME/.ssh/authorized_keys" ]; then
    sudo cp "$HOME/.ssh/authorized_keys" /etc/dropbear/initramfs/authorized_keys
    sudo chmod 600 /etc/dropbear/initramfs/authorized_keys
    sudo update-initramfs -u
    echo "[OK] Pre-boot authorized keys configured."
fi

# 4. Install Official Docker Engine (Bypass Snap)
echo "[4/7] Installing Official Docker CE (Apt repository)..."
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"

# 5. Install Tailscale Mesh VPN
echo "[5/7] Installing Tailscale WireGuard Mesh..."
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh || true

# 6. Configure UFW Strict Firewall
echo "[6/7] Locking down UFW Firewall (Zero Inbound Port Forwarding)..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow in on tailscale0 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw --force enable

# 7. Install Dokploy PaaS Engine
echo "[7/7] Installing Dokploy Self-Hosted PaaS Engine..."
curl -sSL https://dokploy.com/install.sh | sudo sh

echo "======================================================================"
echo "[SUCCESS] Savannah Secure Edge Node Bootstrap Complete!"
echo "Dokploy Dashboard: http://$(hostname -I | awk '{print $1}'):3000"
echo "Pre-Boot SSH Unlock Port: 2222 (command: cryptroot-unlock)"
echo "======================================================================"
