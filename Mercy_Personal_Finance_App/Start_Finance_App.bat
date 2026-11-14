@echo off
title Mercy Personal Finance App (Port 5180)
cd /d "C:\Users\user\Documents\Mercy_Personal_Finance_App"

echo ========================================================================
echo   MERCY PERSONAL FINANCE APP - STANDALONE LAUNCHER (PORT 5180)
echo ========================================================================

netstat -ano | findstr ":5180 " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Starting standalone Personal Finance server on port 5180...
    start "Mercy Personal Finance Server" /min node "C:\Users\user\Documents\Mercy_Personal_Finance_App\server.mjs"
    timeout /t 2 /nobreak >nul
) else (
    echo Personal Finance server is already running on port 5180!
)

echo Opening Personal Finance Dashboard at http://127.0.0.1:5180 ...
start "" "http://127.0.0.1:5180"
