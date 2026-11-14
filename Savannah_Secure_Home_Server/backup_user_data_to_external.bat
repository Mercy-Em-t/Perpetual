@echo off
setlocal
echo ======================================================================
echo SAVANNAH HOME SERVER: FULL LAPTOP USER BACKUP TO EXTERNAL DRIVE (D:)
echo ======================================================================
echo Source:      C:\Users\LIZBETH
echo Destination: D:\LAPTOP_FULL_BACKUP_2026\Users_LIZBETH
echo Free on D:   ~392 GB
echo ======================================================================
echo.

if not exist "D:\LAPTOP_FULL_BACKUP_2026" (
    mkdir "D:\LAPTOP_FULL_BACKUP_2026"
)

echo Starting high-speed robocopy backup...
echo This will safely back up Desktop, Documents, Projects, Downloads, SSH keys,
echo and AppData while skipping recursive directory loops.
echo Log is written to: D:\LAPTOP_FULL_BACKUP_2026\backup_log.txt
echo.

robocopy "C:\Users\LIZBETH" "D:\LAPTOP_FULL_BACKUP_2026\Users_LIZBETH" /E /ZB /XJ /R:1 /W:1 /NP /LOG:"D:\LAPTOP_FULL_BACKUP_2026\backup_log.txt" /TEE

echo.
echo ======================================================================
echo [COMPLETE] User data backup finished!
echo Verify your files in: D:\LAPTOP_FULL_BACKUP_2026\Users_LIZBETH
echo Log details saved to: D:\LAPTOP_FULL_BACKUP_2026\backup_log.txt
echo ======================================================================
pause
