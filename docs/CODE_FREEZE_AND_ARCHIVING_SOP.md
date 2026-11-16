# Code Freeze & Branch Archiving Protocol
**Standard Operating Procedure (SOP) — Git Repository Health & Branch Pruning**
*Document Version: 1.0.0 | Author: Platform Release & Architecture Sentinel*

---

## 1. Executive Summary & Purpose

Over the development lifecycle of `Mercy-Em-t/Perpetual` and `tms-whitelabel-core`, numerous prototype branches, temporary scratch files, and exploratory scripts were created. 

To ensure continuous deployment on Pavilion remains 100% deterministic and free from merge ambiguity, this SOP establishes:
1. **The Branch Tiering Standard**: Active production branches vs. archived historical branches.
2. **The `archive/` Namespace**: Safe preservation of historical experiments without polluting the active branch list.
3. **The `.gitignore` Invariant**: Strict exclusion of database backup dumps, test session credentials, and OS temporary files.

---

## 2. Branch Classification & Retention Rules

| Branch Tier | Naming Pattern | Permitted Work | Deployment Target |
| :--- | :--- | :--- | :--- |
| **Production** | `main` | Production-ready, fully tested code only. Protected branch. | Hot-reloaded to Pavilion via 5-min auto-sync and `deploy_pavilion.ps1`. |
| **Feature / Bugfix** | `feat/<name>`, `fix/<name>` | Short-lived branches (< 3 days). Must pass 42/42 tests before merging. | Staging / Local dev server. |
| **Archived Experiments** | `archive/<original-branch-name>` | Read-only historical snapshots. Merges forbidden. | Archived; never deployed to Pavilion. |

---

## 3. Step-by-Step Archiving & Pruning Workflow

### Step 1: Audit Unmerged and Stale Branches
Run a remote branch audit to identify branches that have been merged or abandoned:
```bash
git fetch --prune origin
git branch -r --merged origin/main
```

### Step 2: Tag & Rename to `archive/` Namespace
For branches containing experimental code that must be preserved for patent, historical, or algorithmic reference:
```bash
# Example: Archiving a legacy experiment branch
git branch -m legacy-feature archive/legacy-feature
git push origin archive/legacy-feature
git push origin --delete legacy-feature
```

### Step 3: Delete Merged Local Branches
Clean up local working copies:
```bash
git branch --merged main | grep -v "main" | xargs -n 1 git branch -d
```

---

## 4. Repository Hygiene & Zero Git Bloat Invariant

To guarantee that git clone operations on Pavilion remain instantaneous (sub-5 seconds):
1. **No Binary Bloat in Git**:
   - Database backups (`*.json.gz`, `*.sql.gz`) must **never** be checked into git. They are managed exclusively under `/opt/savannah-server/backups/` and external cloud storage.
2. **Session Security**:
   - The WhatsApp Baileys credentials directory (`.auth_whatsapp_baileys/`) must be listed in `.gitignore` with `*` wildcards.
3. **Node Modules & Caches**:
   - `node_modules/`, `.vite/`, `dist/`, and `.system_generated/` must remain permanently ignored.
