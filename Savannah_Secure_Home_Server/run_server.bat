@echo off
setlocal
where python >nul 2>nul
if %errorlevel% equ 0 (
    set PYCMD=python
) else (
    set PYCMD=py -3.11
)
cd /d %~dp0
echo ======================================================================
echo SAVANNAH SECURE HOME SERVER: STARTING CORE API (FASTAPI + AGENTS)
echo ======================================================================
echo Listening at: http://127.0.0.1:8000
echo Interactive API docs at: http://127.0.0.1:8000/docs
echo ======================================================================
%PYCMD% -m uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
pause
