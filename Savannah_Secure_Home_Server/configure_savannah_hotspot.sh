#!/usr/bin/env bash
# ==============================================================================
# Savannah Autonomous Secure Edge Home Server - 24/7 Virtual AP Hotspot & NAT Router
# Target: Ubuntu Server 24.04 LTS (HP Pavilion - RTL8821CE)
# ==============================================================================

set -euo pipefail

echo "======================================================================"
echo "SAVANNAH SECURE EDGE: DEPLOYING 24/7 HOME WI-FI HOTSPOT & ROUTER"
echo "======================================================================"

# 1. Permanent Hardware MAC binding for Konnect
echo "[1/5] Locking Konnect profile to Pavilion's permanent hardware MAC..."
PAVILION_HW_MAC="dc:f5:05:97:f6:09"

if nmcli connection show "KONNECT" >/dev/null 2>&1; then
    nmcli connection modify "KONNECT" \
        802-11-wireless.cloned-mac-address "$PAVILION_HW_MAC" \
        802-11-wireless.mac-address-randomization never \
        connection.autoconnect yes \
        connection.autoconnect-priority 80
    echo "[OK] KONNECT connection locked to hardware MAC: $PAVILION_HW_MAC"
fi

# 2. Configure Raeith1 fallback connection
if nmcli connection show "Raeith1" >/dev/null 2>&1; then
    nmcli connection modify "Raeith1" \
        connection.autoconnect yes \
        connection.autoconnect-priority 100
    echo "[OK] Raeith1 fallback priority set to 100."
fi

# 3. Enable IP Forwarding in Kernel for Routing/NAT
echo "[2/5] Enabling IPv4 packet forwarding in kernel..."
echo "net.ipv4.ip_forward=1" | sudo tee /etc/sysctl.d/99-savannah-forward.conf
sudo sysctl -p /etc/sysctl.d/99-savannah-forward.conf

# 4. Provision Virtual AP Interface (uap0) if supported
echo "[3/5] Checking virtual AP capabilities on wlo1..."
PHYSICAL_DEV="wlo1"
AP_DEV="uap0"

# Remove existing uap0 if present to ensure clean state
if ip link show "$AP_DEV" >/dev/null 2>&1; then
    sudo iw dev "$AP_DEV" del 2>/dev/null || true
fi

# Attempt to create virtual AP interface on same physical radio
if sudo iw dev "$PHYSICAL_DEV" interface add "$AP_DEV" type __ap 2>/dev/null; then
    echo "[OK] Successfully created virtual AP interface: $AP_DEV"
    TARGET_HOTSPOT_IF="$AP_DEV"
else
    echo "[INFO] Interface add not supported concurrently by driver; using NetworkManager shared mode on $PHYSICAL_DEV"
    TARGET_HOTSPOT_IF="$PHYSICAL_DEV"
fi

# 5. Configure NetworkManager Hotspot Profile (Savannah-Home)
echo "[4/5] Configuring Savannah-Home Wi-Fi Access Point..."
HOTSPOT_CON_NAME="Savannah-Home"
HOTSPOT_SSID="Savannah-Home"
HOTSPOT_PASS="savannah2026"

# Delete any old hotspot profile with same name
nmcli connection delete "$HOTSPOT_CON_NAME" 2>/dev/null || true

# Create NetworkManager shared AP connection
nmcli connection add \
    type wifi \
    ifname "$TARGET_HOTSPOT_IF" \
    con-name "$HOTSPOT_CON_NAME" \
    autoconnect yes \
    ssid "$HOTSPOT_SSID"

nmcli connection modify "$HOTSPOT_CON_NAME" \
    802-11-wireless.mode ap \
    802-11-wireless.band bg \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$HOTSPOT_PASS" \
    ipv4.method shared

echo "[5/5] Activating Savannah-Home Access Point..."
nmcli connection up "$HOTSPOT_CON_NAME" || true

echo "======================================================================"
echo "SAVANNAH HOME ROUTER ACTIVATED!"
echo "SSID:     $HOTSPOT_SSID"
echo "Password: $HOTSPOT_PASS"
echo "Hardware MAC on Konnect: $PAVILION_HW_MAC"
echo "======================================================================"
