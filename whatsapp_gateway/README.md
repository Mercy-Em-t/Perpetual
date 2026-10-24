# Perpetual Dedicated WhatsApp Gateway Microservice

A self-contained, isolated WhatsApp Gateway and Community Command Center built strictly for the **Perpetual** workspace.

## Architecture
- **Service Entry:** `whatsapp_service.mjs`
- **Isolated Authentication Directory:** `.auth_whatsapp_baileys/` (local to this repository; zero coupling to outside folders)
- **Local HTTP IPC Port:** `5174` (bound to `127.0.0.1`)
- **Community Groups Managed:**
  1. `perpetua` (`120363429929736148@g.us`) — Creative Studio Hub & Generation Drops
  2. `Perpetua - IT Helpdesk` (`120363432040872305@g.us`) — Live Error Catcher & Support Tickets
  3. `Perpetua - Admin Oversight` (`120363415291701803@g.us`) — Capacity Planning & Executive Task Pooling

## Two-Way Interactive Bot Commands
Text from any authorized member in the community groups:
- `!status` / `!health` — Live server telemetry, memory, active workers, open ticket count.
- `!pool` — Active tasks in the 5-Stage ASADF FSM.
- `!ticket <issue>` — Creates a new incident ticket in SQLite (`TICK-xxx`) and notifies IT Helpdesk.
- `!assign <task_id> to <agent>` — Reassigns an in-flight task to another worker.
- `!resolve <ticket_id> [notes]` — Resolves an incident ticket.
- `!help` — Interactive command manual.

## Starting the Service
```powershell
# From this directory:
npm start
# or:
.\start_gateway.bat
```
