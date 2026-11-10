@echo off
setlocal
echo ======================================================================
echo SAVANNAH HOME SERVER: DOWNLOAD OFFICIAL UBUNTU SERVER 24.04 LTS ISO
echo ======================================================================
echo Destination: D:\Server_Boot_Media\ubuntu-24.04.5-live-server-amd64.iso
echo ======================================================================

if not exist "D:\Server_Boot_Media" (
    mkdir "D:\Server_Boot_Media"
)

echo Downloading Ubuntu Server 24.04 LTS (~3.8 GB) with resume support...
curl.exe -L -C - -o "D:\Server_Boot_Media\ubuntu-24.04.5-live-server-amd64.iso" "https://releases.ubuntu.com/noble/ubuntu-24.04.5-live-server-amd64.iso"

echo.
echo ======================================================================
echo [COMPLETE] Download finished!
echo ISO Location:   D:\Server_Boot_Media\ubuntu-24.04.5-live-server-amd64.iso
echo Rufus Location: D:\Server_Boot_Media\rufus-4.5.exe
echo ======================================================================
pause
