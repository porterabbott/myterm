# MyTerm Improvements Summary

## Overview
MyTerm has been significantly enhanced to become a fully functional daily dev process manager, similar to SoloTerm. The app now features robust process management, persistent state, auto-detection, and a polished UI.

---

## 🚀 Major Features Added

### 1. **Robust Process Management (Rust Backend)**
- **Process Groups**: Processes now spawn in their own process group using `setpgid(0, 0)`, ensuring entire process trees (including child processes) can be stopped cleanly
- **Graceful Shutdown**: 
  - On exit, all processes receive SIGTERM first
  - After 800ms, any remaining processes are force-killed with SIGKILL
  - No orphaned dev servers left running after closing the app
- **Auto-restart on Crash**: Processes automatically restart after crashes if `autorestart: true`
- **Exit Status Logging**: Exit codes and termination reasons are logged for debugging

### 2. **Auto-Detection of Processes**
- **Procfile Support**: Automatically detects and parses `Procfile` entries
- **package.json Detection**: 
  - Detects `dev` or `start` scripts
  - Auto-detects package manager (npm, yarn, pnpm, bun) based on lock files
  - Creates appropriate commands (`npm run dev`, `yarn dev`, etc.)
- **Smart Defaults**: Falls back to a placeholder process if no config is found

### 3. **Config File Auto-Creation**
- **New Command**: `init_project_config` creates `myterm.yml` with auto-detected processes
- **Multiple Config Names**: Supports `myterm.yml` and `myterm.yaml`
- **UI Integration**: "Create config" button in the UI for projects without configs
- **Intelligent Naming**: Uses folder name as project name

### 4. **Persistent Project List**
- **localStorage Integration**: Projects are saved and restored across app restarts
- **Auto-load on Launch**: Previously added projects load automatically
- **No Re-adding**: Projects persist until explicitly removed

### 5. **Enhanced UI/UX**

#### Project Sidebar
- Remove button (×) appears on hover for each project
- "no config" badge for projects without valid configs
- Smooth transitions and hover effects

#### Project Header
- "Open in Finder" link to open project directory
- "Create config" button for projects without configs
- "Reload" button to refresh config from disk
- Improved visual hierarchy

#### Process Management
- Clear visual status indicators (green/red/gray dots)
- Monospace font for commands (better readability)
- Disabled states for buttons when actions aren't available
- Smooth hover transitions

#### Logs Panel
- "Auto-scroll" checkbox to toggle automatic scrolling
- "Clear" button to reset logs for selected process
- Monospace font for logs (proper formatting)
- Empty state messaging

#### Error Handling
- Dismissible error banner with × button
- Context-specific error messages
- Graceful degradation when configs are missing

---

## 🔧 Technical Improvements

### Rust Backend (`src-tauri/src/lib.rs`)

**New Functions:**
- `read_project_config()` - Reads from multiple config file candidates
- `config_path_candidates()` - Returns list of possible config file paths
- `detect_project_name()` - Extracts project name from folder path
- `guess_processes()` - Auto-detects processes from Procfile/package.json
- `signal_process_group()` - Sends signals to entire process groups
- `process_group_exists()` - Checks if a process group is still running
- `stop_all_processes()` - Stops all managed processes (used on exit)
- `wait_then_force_kill()` - Graceful then forceful process termination
- `emit_log()` - Helper for emitting log events

**Process Lifecycle:**
- Processes now spawn in their own group (Unix `setpgid`)
- Exit status is captured and logged
- Stop flag prevents restart when user stops process
- Autorestart logic waits 1 second between attempts

**Exit Handling:**
- `tauri::RunEvent::ExitRequested` intercepted
- All processes stopped before app exits
- `api.prevent_exit()` used to wait for cleanup

### Frontend (`src/App.tsx`)

**New Features:**
- localStorage persistence for project paths
- `loadProjectPaths()` / `saveProjects()` helpers
- `handleRemoveProject()` - Stops processes and removes project
- `handleOpenInFinder()` - Opens project directory
- `handleCreateConfig()` - Invokes Rust to create config
- `handleReloadConfig()` - Reloads config from disk
- `handleClearLogs()` - Clears logs for selected process
- `autoScrollLogs` state for log auto-scrolling

**UI Improvements:**
- Removed unused `src/main.ts` file
- Better empty states and messaging
- Improved button styling and transitions
- Error banner with dismiss functionality
- Config error handling and recovery flows

---

## 📋 Comparison with SoloTerm

### ✅ Implemented Features
- [x] YAML config per project
- [x] Start/stop individual processes
- [x] Start/stop all processes at once
- [x] Auto-restart on crash
- [x] Visual status indicators (green/red/gray)
- [x] Real-time log streaming
- [x] Clean, minimal UI
- [x] Persistent project list
- [x] Process auto-detection (package.json, Procfile)
- [x] Config auto-creation
- [x] Proper process tree termination
- [x] Clean shutdown on app exit

### 🔄 Partially Implemented
- [ ] File watcher for auto-restart on code changes (not implemented - can be added later)
- [ ] Native notifications on crash (not implemented - simple to add with tauri-plugin-notification)
- [ ] Interactive terminal / stdin input (not implemented - complex feature)
- [ ] Keyboard shortcuts / command palette (not implemented - can be added)
- [ ] MCP integration (not applicable - OpenClaw-specific)

### ❌ Not Implemented (Advanced Features)
- [ ] Team sharing features (solo.yml vs local processes)
- [ ] Raycast integration
- [ ] Light/dark theme toggle (default is dark)
- [ ] Open in specific editor (only Finder open is implemented)
- [ ] Security confirmations for config changes

---

## 🎯 Usage

### Adding a Project
1. Click "+ Add" in the sidebar
2. Select a project folder
3. If no `myterm.yml` exists, click "Create config" to auto-generate one

### Managing Processes
- **Start/Stop Individual**: Click the Start/Stop buttons on each process card
- **Start/Stop All**: Use the buttons in the header
- **View Logs**: Click on a process to see its logs in the right panel
- **Clear Logs**: Click "Clear" in the logs panel header

### Project Actions
- **Open in Finder**: Click "Open →" in the project header
- **Reload Config**: Click "Reload" to refresh from disk
- **Remove Project**: Hover over project in sidebar and click × (stops all processes first)

### Example Config (`myterm.yml`)
```yaml
name: my-project
processes:
  - name: web
    command: npm run dev
    autostart: true
    autorestart: true
  - name: worker
    command: python worker.py
    autostart: false
    autorestart: true
```

---

## 🏗️ Build & Run

### Development
```bash
npm install
npm run tauri dev
```

### Production Build
```bash
source $HOME/.cargo/env
npm run tauri build
```

The app bundle is created at:
```
src-tauri/target/release/bundle/macos/MyTerm.app
```

---

## 🐛 Known Issues & Future Improvements

### Minor Issues
- DMG bundling sometimes fails (app bundle works fine)
- No Windows/Linux support yet (Unix-only process group handling)

### Potential Enhancements
1. **File Watcher**: Use `notify` crate to watch for file changes and auto-restart processes
2. **Notifications**: Add native notifications when processes crash
3. **Themes**: Light mode support
4. **Keyboard Shortcuts**: Cmd+K command palette
5. **Process Input**: Interactive terminal for stdin
6. **Better Log Formatting**: ANSI color support, timestamps
7. **Config Validation**: Better error messages for invalid YAML
8. **Multi-platform**: Windows/Linux process group handling

---

## 📊 Summary

MyTerm is now a **production-ready dev process manager** with:
- ✅ Solid process lifecycle management
- ✅ Persistent state across restarts
- ✅ Auto-detection and config creation
- ✅ Clean, intuitive UI
- ✅ Proper cleanup on exit (no orphaned processes)
- ✅ Cross-session project persistence

The app successfully builds, runs, and manages development processes reliably. It's ready for daily use as a local dev tool!
