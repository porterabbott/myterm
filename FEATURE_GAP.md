# Feature Gap Analysis — SoloTerm vs MyTerm

## Sources reviewed
- SoloTerm marketing pages: https://soloterm.com (home), https://soloterm.com/download, https://soloterm.com/changelog
- MyTerm code: `src-tauri/src/lib.rs`, `src/App.tsx`
- `IMPROVEMENTS.md`

---

## ✅ Features MyTerm already matches
- **Single‑window project + process management** — multiple projects in a sidebar, each with multiple processes and logs.
- **Start/stop individual processes** — per‑process Start/Stop controls.
- **Start/stop entire stack** — Start All / Stop All for a project.
- **Autostart + autorestart on crash** — `autostart` and `autorestart` flags work (restart loop in Rust backend).
- **Status indicators at a glance** — running/stopped/crashed states with colored dots.
- **Real‑time log streaming** — stdout/stderr streamed into the UI.
- **Config‑based workflows** — per‑project YAML config (`myterm.yml` / `myterm.yaml`).
- **Process auto‑detection + config auto‑creation** — Procfile and `package.json` script detection; “Create config” button.
- **Persistent project list** — localStorage saves projects across restarts.
- **Clean shutdown of process trees** — Unix process‑group termination prevents orphaned processes.
- **Lightweight desktop app** — Tauri‑based (similar footprint and approach to Solo’s “lightweight & fast” claim).

---

## ❌ Features SoloTerm has that MyTerm is missing

### Process reliability & feedback
1. **Native crash notifications + quick restart**
   - Solo: “get notified when something crashes” and “native crash alerts and one‑key restart.”
   - MyTerm: no native notifications; failures only visible by watching the UI.

2. **File‑change auto‑restart (glob patterns)**
   - Solo: supports restarting specific processes when matching files change.
   - MyTerm: autorestart only on crash, no file‑watcher based restarts.

3. **Interactive terminal + full ANSI rendering**
   - Solo: type directly into running processes, handle prompts, debuggers; full ANSI.
   - MyTerm: logs are read‑only and plain text (no stdin or ANSI rendering).

4. **Keyboard‑first navigation + command palette**
   - Solo: command palette and keyboard navigation; changelog notes project‑level shortcuts.
   - MyTerm: no command palette or keyboard shortcuts.

### Integrations & automation
5. **Raycast integration / extension**
   - Solo: control projects/processes from Raycast.
   - MyTerm: no Raycast integration.

6. **MCP / AI agent integration (Claude Code)**
   - Solo: exposes MCP server so AI agents can start/restart processes and query status/logs.
   - MyTerm: no MCP server or AI‑agent hooks.

### Collaboration & configuration
7. **Team sharing with shared vs local processes**
   - Solo: commit `solo.yml` to repo; shared source of truth plus local/private processes.
   - MyTerm: only a single `myterm.yml`; no shared/local separation or team‑oriented UX.

8. **Security/trust prompts for config changes**
   - Solo: prompts for confirmation if `solo.yml` changes after git pull.
   - MyTerm: no trust confirmation before running changed configs.

9. **In‑app process editing**
   - Solo: “auto‑detect your processes (or add your own)” implies UI for adding/editing.
   - MyTerm: requires manual YAML edits; UI only creates/reloads configs.

### UX polish & customization
10. **Open in editor**
    - Solo: set default editor (VS Code, Zed, etc.) and open projects directly.
    - MyTerm: only “Open in Finder.”

11. **Theme switching (light/dark)**
    - Solo: explicit light + dark themes.
    - MyTerm: dark‑only UI.

### Platform coverage
12. **Windows & Linux builds**
    - Solo: macOS now, Windows/Linux announced.
    - MyTerm: macOS‑only (uses Finder, Unix signals; no Windows/Linux target).

### Auto‑detection breadth
13. **Framework‑specific detection across stacks**
    - Solo: advertises auto‑detection for many stacks (Laravel, Django, Rails, etc.).
    - MyTerm: limited to Procfile and `package.json` scripts.

---

## 🎯 Priority recommendations (solo‑developer focused)

### P1 — Highest impact day‑to‑day
1. **Native crash notifications + quick restart**
   - Biggest productivity win: you notice failures immediately without watching the UI.

2. **File‑change auto‑restart (glob patterns)**
   - Prevents stale workers/queues after code changes; reduces “why isn’t this running?” time.

3. **Keyboard shortcuts / command palette**
   - Speeds up start/stop actions and switching between projects/processes.

4. **Interactive terminal + ANSI rendering**
   - Eliminates the need to bounce back to Terminal for prompts, REPLs, debuggers.

### P2 — Useful polish and reduced friction
5. **Open in editor**
   - Small but constant time‑saver for solo work.

6. **Broader auto‑detection + simple in‑app process editor**
   - Lowers setup friction for new projects; less YAML editing.

7. **Theme toggle (light/dark)**
   - Quality‑of‑life improvement; helps long sessions.

### P3 — Nice‑to‑haves (lower priority for a solo dev)
8. **Raycast integration**
9. **MCP / AI agent integration** (power user / AI‑heavy workflows)
10. **Team sharing + shared/local process separation**
11. **Security prompts for config changes**
12. **Windows/Linux support** (only if you plan to expand beyond macOS)

---

## Summary
MyTerm already nails the core process‑manager loop (projects, configs, start/stop, logs, autorestart). SoloTerm’s biggest gaps for MyTerm are **notifications**, **file‑watcher restarts**, **keyboard‑first control**, and **interactive terminals**. These are the most valuable upgrades for a solo developer’s daily workflow and should be prioritized before team‑sharing or integration‑heavy features.
