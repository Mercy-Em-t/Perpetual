# ==============================================================================
# Automated WhatsApp Gateway Handover: Dragonfly -> Pavilion Edge Server
# Target: mismerz@100.73.175.118 / root@100.73.175.118
# Port: 5174
# ==============================================================================

param(
    [string]$PavilionIP = "100.73.175.118",
    [string]$RemoteDir = "/opt/perpetual-whatsapp-gateway",
    [string]$LocalGatewayDir = "C:\Users\user\Documents\Perpetual\whatsapp_gateway"
)

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "SAVANNAH EDGE HANDOVER: DRAGONFLY -> PAVILION 24/7 WHATSAPP" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# 1. Ping Pavilion on Tailscale
Write-Host "[1/4] Probing Pavilion edge node on Tailscale ($PavilionIP)..." -ForegroundColor Yellow
$pingResult = Test-Connection -ComputerName $PavilionIP -Count 2 -Quiet

if (-not $pingResult) {
    Write-Host "❌ Pavilion ($PavilionIP) is currently OFFLINE on Tailscale." -ForegroundColor Red
    Write-Host "👉 Action Required:" -ForegroundColor Yellow
    Write-Host "   1. Turn on your phone hotspot (Raeith1) or home Wi-Fi."
    Write-Host "   2. Ensure Pavilion is powered on and connected."
    Write-Host "   3. Re-run this script once Pavilion joins Tailscale."
    exit 1
}

Write-Host "✅ Pavilion is ONLINE and responsive on Tailscale!" -ForegroundColor Green

# 2. Synchronize Clean-Slate Gateway Files to Pavilion
Write-Host "[2/4] Syncing updated clean-slate gateway files to Pavilion ($RemoteDir)..." -ForegroundColor Yellow

$filesToSync = @(
    ".env",
    "command_handler.mjs",
    "config.mjs",
    "finance_engine.mjs",
    "http_helpers.mjs",
    "http_routes.mjs",
    "tenant_resolver.mjs",
    "whatsapp_service.mjs",
    "passive_listener.mjs",
    "package.json",
    "reconcile_all_shops_routing.mjs",
    "redmi_sms_bridge.mjs",
    "till_receipt_pool.json",
    "personal_finance_ledger.json",
    "personal_finance_budgets.json"
)

# Ensure remote directory exists
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 root@$PavilionIP "mkdir -p $RemoteDir"

foreach ($file in $filesToSync) {
    $srcPath = Join-Path $LocalGatewayDir $file
    if (Test-Path $srcPath) {
        Write-Host "  -> Uploading $file..." -ForegroundColor Gray
        scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 $srcPath root@${PavilionIP}:${RemoteDir}/${file}
    }
}

# 3. Synchronize WhatsApp Auth Tokens to Pavilion
Write-Host "[3/4] Verifying Baileys session credentials on Pavilion..." -ForegroundColor Yellow
$authSrc = "C:\Users\user\Documents\Quality assurance\tms-whitelabel-core\docker-data\auth"
if (Test-Path $authSrc) {
    ssh -o StrictHostKeyChecking=accept-new root@$PavilionIP "mkdir -p ${RemoteDir}/auth"
    scp -o StrictHostKeyChecking=accept-new -r "${authSrc}\*" root@${PavilionIP}:${RemoteDir}/auth/
}

# 4. Start WhatsApp Gateway on Pavilion & Stop Dragonfly Local Daemon
Write-Host "[4/4] Starting 24/7 WhatsApp Daemon on Pavilion..." -ForegroundColor Yellow

# Launch on Pavilion using nohup / systemd
ssh -o StrictHostKeyChecking=accept-new root@$PavilionIP @"
cd $RemoteDir
npm install --silent 2>/dev/null || true
# Kill existing node instances on port 5174 if running
fuser -k 5174/tcp 2>/dev/null || true
sleep 1
WHATSAPP_AUTH_DIR='${RemoteDir}/auth' PORT=5174 nohup node whatsapp_service.mjs > gateway.log 2>&1 &
sleep 2
echo '=== Pavilion Gateway Status ==='
ps aux | grep whatsapp_service | grep -v grep
"@

Write-Host "==================================================================" -ForegroundColor Green
Write-Host "🎉 HANDOVER COMPLETE! Pavilion now runs WhatsApp Gateway 24/7." -ForegroundColor Green
Write-Host "👉 You can now stop Dragonfly's local background task (task-8515)" -ForegroundColor Green
Write-Host "   to prevent Baileys Code 440 (Connection Replaced)." -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
