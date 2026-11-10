@echo off
setlocal
echo ======================================================================
echo SAVANNAH HOME SERVER: CLOUDFLARE ZERO TRUST TUNNEL LAUNCHER
echo ======================================================================
echo Forwarding public HTTPS traffic to local server at: http://127.0.0.1:8000
echo ======================================================================
echo.

if not exist "%~dp0cloudflared.exe" (
    echo [ERROR] cloudflared.exe not found in this folder!
    pause
    exit /b 1
)

echo Starting Cloudflare Tunnel...
echo A public HTTPS URL (e.g. https://...trycloudflare.com) will appear below.
echo You can use that URL to access this server from your other PC or phone!
echo.
"%~dp0cloudflared.exe" tunnel --url http://127.0.0.1:8000
pause
