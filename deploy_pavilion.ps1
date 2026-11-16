# ==============================================================================
# Pavilion 1-Tap Instant Deployment Script (Option C)
# ==============================================================================
# Triggers an instant Git pull and hot-reload on Pavilion (100.73.175.118)
# over your private Tailscale WireGuard mesh with zero credential risk.

param (
    [string]$HostIp = "100.73.175.118",
    [string]$User = "mismercz",
    [string]$KeyPath = "$HOME\.ssh\id_ed25519"
)

$ErrorActionPreference = "Stop"

Write-Host "==============================================================" -ForegroundColor Cyan
Write-Host "🚀 DISPATCHING 1-TAP INSTANT HOT-RELOAD TO PAVILION ($HostIp)" -ForegroundColor Cyan
Write-Host "==============================================================" -ForegroundColor Cyan

# 1. Trigger remote git pull & container sync
Write-Host "📦 Pulling latest main and syncing container on Pavilion..." -ForegroundColor Yellow
$remoteCmd = "cd /home/mismercz/Perpetual && git fetch origin main -q && git pull origin main -q && docker cp /home/mismercz/Perpetual/whatsapp_gateway/. savannah-whatsapp-daemon:/app/gateway/ && docker restart savannah-whatsapp-daemon > /dev/null && git log -1 --oneline"

$latestCommit = ssh -n -i $KeyPath "$User@$HostIp" $remoteCmd

Write-Host "✅ Synced to Commit: $latestCommit" -ForegroundColor Green

# 2. Poll for Baileys socket handshake and UP status (up to 15s)
Write-Host "🩺 Verifying live container health..." -ForegroundColor Yellow
$healthy = $false
$healthJson = ""

for ($i = 1; $i -le 10; $i++) {
    Start-Sleep -Seconds 2
    $healthJson = ssh -n -i $KeyPath "$User@$HostIp" "curl -sf http://localhost:8085/health 2>/dev/null"
    if ($healthJson -and $healthJson -match '"status":"UP"') {
        $healthy = $true
        break
    }
}

if ($healthy) {
    Write-Host "==============================================================" -ForegroundColor Green
    Write-Host "🎉 PAVILION DEPLOYMENT VERIFIED & HEALTHY!" -ForegroundColor Green
    Write-Host "Telemetry: $healthJson" -ForegroundColor White
    Write-Host "==============================================================" -ForegroundColor Green
} else {
    Write-Host "⚠️ Warning: Service is restarting or health check timed out." -ForegroundColor DarkYellow
}
