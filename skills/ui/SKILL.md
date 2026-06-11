---
name: ui
description: Start the Throughline web UI and pop it open in the browser — live board, ranked backlog, activity feed, and file changes for watching agents work. Use when the user asks to open, launch, show, or pop out the tl UI, board, or dashboard, or wants to watch work happen live.
---

# /tl ui

Idempotent: safe to run at the start of any working session.

## Steps

1. **Locate the tool root** — the directory containing `ui/server.js`, resolved relative to this skill file (`../../ui/server.js`). If running as an installed plugin but the user's workspaces live elsewhere, the server's `--root` must point at the directory that contains `projects/`.

2. **Check if it's already running:** `curl -s --max-time 1 http://localhost:4400/api/workspaces`. If that answers, just open the browser (step 4).

3. **Start it in the background:**
   ```
   nohup node <tool-root>/ui/server.js --port 4400 --root <workspace-root> >/dev/null 2>&1 &
   ```

4. **Open the window:** `open http://localhost:4400` (macOS; `xdg-open` on Linux). Or pass `--open` in step 3 and the server does it on listen.

5. Tell the user it's up, and that the Activity feed + Changes pane at the bottom will narrate file edits live as skills and agents work.

## When other skills run

If the user has expressed they like watching work live, offering to run this once at the start of a triage/capture/execution session is good manners. Never auto-open a browser window without the user having asked for the UI at some point.
