# 🎒 Perpetual One: Cloud Migration Kit & Journey Guide

**Version:** 1.0.0-MIGRATION  
**Target:** Ubuntu / Debian / Rocky Linux VPS, Droplet, EC2, or Dedicated Host  
**Repository:** [https://github.com/Mercy-Em-t/Perpetual.git](https://github.com/Mercy-Em-t/Perpetual.git)  

---

## 🚀 1-Step Automatic Cloud Launch

Once your remote cloud terminal is open, run this single line to deploy the entire platform:

```bash
curl -sSL https://raw.githubusercontent.com/Mercy-Em-t/Perpetual/main/cloud_deploy.sh | bash
```

Or manually:
```bash
# 1. Clone the repository
git clone https://github.com/Mercy-Em-t/Perpetual.git
cd Perpetual

# 2. Make the deploy script executable & run
chmod +x cloud_deploy.sh
./cloud_deploy.sh
```

---

## 📦 What Is Packed in the Journey Kit

| Container / Daemon | Internal Port | Host Port | Role & Capabilities |
| :--- | :--- | :--- | :--- |
| **`perpetual-room-server`** | `:5050` | `5050` | ASADF Task FSM, Orders API, Storefront, Reconciler, Event Bus |
| **`perpetual-whatsapp-gateway`** | `:5174` | `5174` | Multi-device Baileys WhatsApp Gateway & Community Router |
| **`perpetual-asset-worker`** | Worker | — | Deterministic 3D Scene renderer & spatial matrix locking |

---

## 🔑 Port & Firewall Rules

Ensure these ports are allowed in your cloud firewall / security group:

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 5050/tcp comment "Perpetual One Core & Storefront"
sudo ufw allow 5174/tcp comment "Perpetual WhatsApp Gateway"
sudo ufw reload
```

---

## 📱 WhatsApp Multi-Device Pairing on the Cloud

1. After launching on the cloud, view the QR code in the gateway logs:
   ```bash
   docker compose logs -f whatsapp-gateway
   ```
2. Open WhatsApp on your phone $\to$ **Linked Devices** $\to$ **Link a Device** $\to$ Scan the terminal QR code.
3. Once authenticated, credentials persist permanently in the `.auth_whatsapp_baileys` volume across server restarts.

---

## 🛠️ Operational Cloud Commands

- **Check Cluster Status:** `docker compose ps`
- **View Live Core Logs:** `docker compose logs -f room-server`
- **View WhatsApp Logs:** `docker compose logs -f whatsapp-gateway`
- **Restart Cluster:** `docker compose restart`
- **Stop Cluster:** `docker compose down`

*Bon voyage! Perpetual One is sealed and cloud-ready.*
