# MyTerm

A lightweight, local dev process manager for macOS built with Tauri + React/TypeScript.

**Inspired by [SoloTerm](https://soloterm.com/)** - manage your entire dev stack in one window.

## Features

✅ **Process Management**
- Start/stop individual processes or entire projects
- Auto-restart on crash
- Real-time log streaming with auto-scroll
- Visual status indicators (🟢 running, 🔴 crashed, ⚫ stopped)

✅ **Smart Config**
- Auto-detect processes from `package.json` or `Procfile`
- One-click config creation
- YAML-based configuration
- Multiple config file support (`myterm.yml`, `myterm.yaml`)

✅ **Persistent State**
- Projects saved across app restarts
- Clean shutdown - no orphaned processes
- Process tree termination (kills child processes too)

✅ **Quality of Life**
- Open projects in Finder
- Reload config from disk
- Clear logs per process
- Remove projects with one click

## Quick Start

### Installation
```bash
npm install
npm run tauri dev
```

### Build for Production
```bash
source $HOME/.cargo/env
npm run tauri build
```

The app bundle will be at:
```
src-tauri/target/release/bundle/macos/MyTerm.app
```

## Usage

### 1. Add a Project
Click **"+ Add"** in the sidebar and select your project folder.

### 2. Create Config (if needed)
If no `myterm.yml` exists, click **"Create config"** to auto-generate one from your `package.json` or `Procfile`.

### 3. Start Processes
Click **"Start"** on individual processes or **"Start all"** to launch everything at once.

## Configuration

Create a `myterm.yml` in your project root:

```yaml
name: my-project
processes:
  - name: web
    command: npm run dev
    autostart: true    # Start automatically when project loads
    autorestart: true  # Restart if crashes
  
  - name: worker
    command: python worker.py
    autostart: false
    autorestart: true
  
  - name: logs
    command: tail -f logs/development.log
    autostart: false
    autorestart: false
```

### Auto-Detection

MyTerm can auto-detect common setups:

**package.json** → Detects `dev` or `start` scripts and the correct package manager (npm/yarn/pnpm/bun)

**Procfile** → Parses all process definitions

**Example auto-generated config:**
```yaml
name: my-app
processes:
  - name: dev
    command: npm run dev
    autostart: false
    autorestart: true
```

## Process Management

### Individual Control
- **Start**: Click the green "Start" button
- **Stop**: Click the red "Stop" button
- **View Logs**: Click on the process card

### Bulk Actions
- **Start All**: Launch all stopped processes
- **Stop All**: Stop all running processes
- **Remove Project**: Hover over project in sidebar and click **×** (stops processes first)

### Logs
- **Auto-scroll**: Toggle to automatically scroll to new log entries
- **Clear**: Remove all logs for the selected process
- **Stderr**: Lines from stderr are prefixed with `[stderr]`

## How It Works

### Process Groups
MyTerm spawns each process in its own process group, ensuring that **child processes** are also terminated when you stop a process. No more orphaned `node` or `python` processes!

### Graceful Shutdown
When you quit MyTerm:
1. All processes receive `SIGTERM` (graceful shutdown)
2. After 800ms, remaining processes get `SIGKILL` (force kill)
3. App exits cleanly

### Auto-Restart
If `autorestart: true`, crashed processes automatically restart after 1 second.

## Keyboard & Mouse

- **Click process card** → View logs
- **Hover project** → Show remove button (×)
- **Cmd+Q** → Quit (stops all processes)

## Technical Details

**Stack:**
- **Backend**: Rust (Tauri 2)
- **Frontend**: React 18 + TypeScript
- **Styling**: Tailwind CSS
- **Process Management**: Unix process groups (`setpgid`)

**Key Features:**
- Process trees properly terminated
- Exit status logging
- localStorage persistence
- Real-time event streaming
- Error boundary handling

## Requirements

- macOS (arm64 or x86_64)
- Node.js 24+
- Rust/Cargo

## Roadmap

**Potential Future Features:**
- [ ] File watcher for auto-restart on code changes
- [ ] Native notifications on crash
- [ ] Interactive terminal (stdin input)
- [ ] Keyboard shortcuts / command palette
- [ ] Light/dark theme toggle
- [ ] Windows/Linux support

## Comparison with SoloTerm

MyTerm implements the **core features** of SoloTerm:
- ✅ YAML config
- ✅ Start/stop processes
- ✅ Auto-restart on crash
- ✅ Status indicators
- ✅ Log streaming
- ✅ Auto-detection
- ✅ Clean UI

**Not included** (advanced features):
- Team sharing (solo.yml)
- MCP integration
- Raycast extension
- File watchers

See [IMPROVEMENTS.md](./IMPROVEMENTS.md) for a detailed feature comparison.

## Examples

### Node.js Project
```yaml
name: my-api
processes:
  - name: server
    command: npm run dev
    autostart: true
    autorestart: true
  - name: worker
    command: npm run worker
    autostart: true
    autorestart: true
```

### Multi-Language Stack
```yaml
name: fullstack-app
processes:
  - name: frontend
    command: npm run dev
    autostart: true
    autorestart: true
  - name: backend
    command: python manage.py runserver
    autostart: true
    autorestart: true
  - name: redis
    command: redis-server
    autostart: true
    autorestart: true
```

### Using Procfile
Create a `Procfile` instead:
```
web: npm run dev
worker: python worker.py
redis: redis-server
```

MyTerm will auto-detect and create the config!

## License

MIT

## Credits

Built with ❤️ using:
- [Tauri](https://tauri.app/) - Lightweight desktop framework
- [React](https://react.dev/) - UI library
- [Tailwind CSS](https://tailwindcss.com/) - Styling

Inspired by [SoloTerm](https://soloterm.com/) - the excellent commercial dev process manager.
