@echo off
REM Savannah Edge Node - Autonomous Agent Swarm CLI Runner
cd /d %~dp0
python src\agents\agent_cli.py %*
