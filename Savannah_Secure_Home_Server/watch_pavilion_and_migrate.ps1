# ==============================================================================
# Autonomous Evening Watcher: 6:00 PM - 10:00 PM EAT
# Detects when you get home and Pavilion connects to Tailscale (100.73.175.118)
# Automatically executes migration and prevents Baileys 440 session collision.
# ==============================================================================

param(
    [string]$PavilionIP = "100.73.175.118",
    [int]$PollIntervalSec = 30
)

$logFile = "D:\Savannah_Secure_Home_Server\handover_watcher.log"

function Log-Message([string]$msg, [string]$color = "White") {
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $formatted = "[$timestamp] $msg"
    Write-Host $formatted -ForegroundColor $color
    Add-Content -Path $logFile -Value $formatted -ErrorAction SilentlyContinue
}

Log-Message "==================================================================" "Cyan"
Log-Message "EVENING WATCHER ACTIVE: Monitoring Pavilion ($PavilionIP)" "Cyan"
Log-Message "Listening for homecoming between 18:00 (6 PM) and 22:00 (10 PM)..." "Cyan"
Log-Message "==================================================================" "Cyan"

while ($true) {
    $now = Get-Date
    $hour = $now.Hour

    # Before 17:45 EAT: sleep in low-power idle mode (check every 5 minutes)
    if ($hour -lt 17 -or ($hour -eq 17 -and $now.Minute -lt 45)) {
        Start-Sleep -Seconds 300
        continue
    }

    # Evening Active Window (17:45 - 22:00 EAT)
    if ($hour -ge 17 -and $hour -lt 22) {
        $isOnline = Test-Connection -ComputerName $PavilionIP -Count 1 -Quiet

        if ($isOnline) {
            Log-Message "🟢 PAVILION DETECTED ONLINE ON TAILSCALE ($PavilionIP)!" "Green"
            Log-Message "Initiating automated 24/7 handover..." "Green"

            # Execute migration script
            & powershell -ExecutionPolicy Bypass -File "D:\Savannah_Secure_Home_Server\migrate_whatsapp_to_pavilion.ps1"

            # Find and stop Dragonfly local node whatsapp_service process to prevent code 440 conflict
            Log-Message "Stopping Dragonfly local WhatsApp gateway process..." "Yellow"
            Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
                $_.CommandLine -match "whatsapp_service\.mjs"
            } | Stop-Process -Force -ErrorAction SilentlyContinue

            Log-Message "🎉 Handover Complete! Pavilion is now the sole active 24/7 WhatsApp host." "Green"
            break
        }
    }

    # Past 22:00: Exit cleanly
    if ($hour -ge 22) {
        Log-Message "Evening window closed (past 22:00). Standby for tomorrow." "Yellow"
        break
    }

    Start-Sleep -Seconds $PollIntervalSec
}
