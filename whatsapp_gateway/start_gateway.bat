@echo off
cd /d "%~dp0"
title Perpetual Dedicated WhatsApp Gateway (:5174)
echo ========================================================
echo   Perpetual Dedicated Autonomous WhatsApp Gateway
echo   Isolated Auth: %~dp0.auth_whatsapp_baileys
echo   Local Port: 5174
echo ========================================================
node whatsapp_service.mjs
