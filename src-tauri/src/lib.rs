use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    env,
    fs::{self},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProcessConfig {
    name: String,
    command: String,
    #[serde(default)]
    autostart: bool,
    #[serde(default)]
    autorestart: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ProjectConfig {
    name: String,
    processes: Vec<ProcessConfig>,
}

#[derive(Default, Clone)]
struct ProcessManager {
    processes: Arc<Mutex<HashMap<String, ManagedProcess>>>,
}

#[derive(Default)]
struct RestartState {
    skip_process_cleanup: AtomicBool,
}

impl RestartState {
    fn mark_update_restart(&self) {
        self.skip_process_cleanup.store(true, Ordering::SeqCst);
    }

    fn should_skip_cleanup(&self) -> bool {
        self.skip_process_cleanup.load(Ordering::SeqCst)
    }
}

struct ManagedProcess {
    /// PID of the shell process we spawn. On Unix we also use this as the process group id (pgid)
    /// because we call `setpgid(0, 0)` in the child.
    pid: u32,
    stop_flag: Arc<AtomicBool>,
    stdin: Arc<Mutex<Option<std::process::ChildStdin>>>,
}

#[derive(Serialize, Clone)]
struct LogEvent {
    project_path: String,
    process_name: String,
    line: String,
    stream: String,
}

#[derive(Serialize, Clone)]
struct StatusEvent {
    project_path: String,
    process_name: String,
    status: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    version: String,
    download_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigFilePayload {
    path: String,
    contents: String,
}

fn process_key(project_path: &str, process_name: &str) -> String {
    format!("{}::{}", project_path, process_name)
}

fn emit_status(app: &AppHandle, project_path: &str, process_name: &str, status: &str) {
    let _ = app.emit(
        "process-status",
        StatusEvent {
            project_path: project_path.to_string(),
            process_name: process_name.to_string(),
            status: status.to_string(),
        },
    );
}

fn emit_log(app: &AppHandle, project_path: &str, process_name: &str, line: String, stream: &str) {
    let _ = app.emit(
        "process-log",
        LogEvent {
            project_path: project_path.to_string(),
            process_name: process_name.to_string(),
            line,
            stream: stream.to_string(),
        },
    );
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    app: AppHandle,
    project_path: String,
    process_name: String,
    stream: &'static str,
    reader: R,
) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines().flatten() {
            let _ = app.emit(
                "process-log",
                LogEvent {
                    project_path: project_path.clone(),
                    process_name: process_name.clone(),
                    line,
                    stream: stream.to_string(),
                },
            );
        }
    });
}

fn config_path_candidates(project_path: &Path) -> Vec<PathBuf> {
    vec![
        project_path.join("myterm.yml"),
        project_path.join("myterm.yaml"),
    ]
}

fn find_existing_config_path(project_path: &Path) -> Option<PathBuf> {
    config_path_candidates(project_path)
        .into_iter()
        .find(|candidate| candidate.exists())
}

fn read_project_config(project_path: &Path) -> Result<ProjectConfig, String> {
    let mut last_err: Option<String> = None;

    for candidate in config_path_candidates(project_path) {
        match std::fs::read_to_string(&candidate) {
            Ok(contents) => {
                return serde_yaml::from_str(&contents)
                    .map_err(|err| format!("{} ({})", err, candidate.display()));
            }
            Err(err) => {
                last_err = Some(format!("{} ({})", err, candidate.display()));
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Missing myterm.yml".to_string()))
}

#[cfg(unix)]
fn signal_process_group(pgid: u32, signal: i32) {
    if pgid == 0 {
        return;
    }

    unsafe {
        // Send to the entire process group to avoid orphaned children.
        // Equivalent to: kill(-pgid, signal)
        let _ = libc::kill(-(pgid as i32), signal);
    }
}

#[cfg(unix)]
fn process_group_exists(pgid: u32) -> bool {
    if pgid == 0 {
        return false;
    }

    unsafe {
        let result = libc::kill(-(pgid as i32), 0);
        if result == 0 {
            return true;
        }

        let err = *libc::__error();
        // ESRCH => no such process / group
        err != libc::ESRCH
    }
}

fn stop_all_processes(manager: &ProcessManager) -> Vec<u32> {
    let mut pgids = Vec::new();

    if let Ok(map) = manager.processes.lock() {
        for entry in map.values() {
            entry.stop_flag.store(true, Ordering::SeqCst);
            if entry.pid > 0 {
                pgids.push(entry.pid);
            }
        }
    }

    #[cfg(unix)]
    {
        for pgid in &pgids {
            signal_process_group(*pgid, libc::SIGTERM);
        }
    }

    pgids
}

#[cfg(unix)]
fn wait_then_force_kill(pgids: Vec<u32>, wait_for: Duration, hard_kill_after: Duration) {
    let start = Instant::now();
    // Give processes a moment to exit cleanly.
    while start.elapsed() < wait_for {
        if pgids.iter().all(|pgid| !process_group_exists(*pgid)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }

    // Still alive? Force kill.
    for pgid in &pgids {
        if process_group_exists(*pgid) {
            signal_process_group(*pgid, libc::SIGKILL);
        }
    }

    // Optionally wait a tiny bit more, but don't block too long on shutdown.
    let start = Instant::now();
    while start.elapsed() < hard_kill_after {
        if pgids.iter().all(|pgid| !process_group_exists(*pgid)) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn detect_project_name(project_path: &Path) -> String {
    project_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project")
        .to_string()
}

fn guess_processes(project_path: &Path) -> Vec<ProcessConfig> {
    let procfile_path = project_path.join("Procfile");
    if let Ok(contents) = std::fs::read_to_string(&procfile_path) {
        let mut processes = Vec::new();
        for line in contents.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((name, cmd)) = trimmed.split_once(':') else {
                continue;
            };
            let name = name.trim();
            let cmd = cmd.trim();
            if name.is_empty() || cmd.is_empty() {
                continue;
            }
            processes.push(ProcessConfig {
                name: name.to_string(),
                command: cmd.to_string(),
                autostart: false,
                autorestart: true,
            });
        }
        if !processes.is_empty() {
            return processes;
        }
    }

    let package_json_path = project_path.join("package.json");
    if let Ok(contents) = std::fs::read_to_string(&package_json_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) {
            let scripts = json.get("scripts");
            let has_dev = scripts
                .and_then(|s| s.get("dev"))
                .and_then(|v| v.as_str())
                .is_some();
            let has_start = scripts
                .and_then(|s| s.get("start"))
                .and_then(|v| v.as_str())
                .is_some();

            if has_dev || has_start {
                let pm = if project_path.join("pnpm-lock.yaml").exists() {
                    "pnpm"
                } else if project_path.join("yarn.lock").exists() {
                    "yarn"
                } else if project_path.join("bun.lockb").exists() {
                    "bun"
                } else {
                    "npm"
                };

                let script = if has_dev { "dev" } else { "start" };

                let cmd = match (pm, script) {
                    ("yarn", "dev") => "yarn dev".to_string(),
                    ("yarn", "start") => "yarn start".to_string(),
                    ("pnpm", "dev") => "pnpm dev".to_string(),
                    ("pnpm", "start") => "pnpm start".to_string(),
                    ("bun", "dev") => "bun run dev".to_string(),
                    ("bun", "start") => "bun run start".to_string(),
                    (_, "dev") => "npm run dev".to_string(),
                    (_, "start") => "npm start".to_string(),
                    _ => "npm run dev".to_string(),
                };

                return vec![ProcessConfig {
                    name: script.to_string(),
                    command: cmd,
                    autostart: false,
                    autorestart: true,
                }];
            }
        }
    }

    vec![ProcessConfig {
        name: "dev".to_string(),
        command: "echo 'Edit myterm.yml to add processes' && sleep 2".to_string(),
        autostart: false,
        autorestart: false,
    }]
}

fn parse_version(version: &str) -> Vec<u32> {
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0))
        .collect()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest_parts = parse_version(latest);
    let current_parts = parse_version(current);
    let max_len = latest_parts.len().max(current_parts.len());

    for idx in 0..max_len {
        let latest_value = *latest_parts.get(idx).unwrap_or(&0);
        let current_value = *current_parts.get(idx).unwrap_or(&0);
        if latest_value > current_value {
            return true;
        }
        if latest_value < current_value {
            return false;
        }
    }

    false
}

fn is_backup_bundle(path: &Path) -> bool {
    path.extension().and_then(|ext| ext.to_str()) == Some("old")
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.ends_with(".app.old"))
            .unwrap_or(false)
}

fn find_app_bundle_path() -> Result<PathBuf, String> {
    let exe_path = env::current_exe().map_err(|err| err.to_string())?;
    for ancestor in exe_path.ancestors() {
        if ancestor.extension().and_then(|ext| ext.to_str()) == Some("app") {
            return Ok(ancestor.to_path_buf());
        }
        if is_backup_bundle(ancestor) {
            return Ok(ancestor.to_path_buf());
        }
    }

    Err("Could not determine app bundle path".to_string())
}

fn resolve_primary_app_bundle_path(running_bundle: &Path) -> PathBuf {
    if is_backup_bundle(running_bundle) {
        running_bundle.with_extension("app")
    } else {
        running_bundle.to_path_buf()
    }
}

fn create_temp_dir() -> Result<PathBuf, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| err.to_string())?
        .as_millis();
    let dir = env::temp_dir().join(format!("myterm-update-{}", stamp));
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    Ok(dir)
}

fn find_app_in_dir(root: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
                return Some(path);
            }
            if let Some(found) = find_app_in_dir(&path) {
                return Some(found);
            }
        }
    }
    None
}

#[tauri::command(rename_all = "camelCase")]
fn load_project_config(path: String) -> Result<ProjectConfig, String> {
    let project_path = Path::new(&path);
    read_project_config(project_path)
}

#[tauri::command(rename_all = "camelCase")]
fn init_project_config(path: String) -> Result<ProjectConfig, String> {
    let project_path = Path::new(&path);
    let config_path = project_path.join("myterm.yml");
    if config_path.exists() {
        return Err(format!("Config already exists at {}", config_path.display()));
    }

    let config = ProjectConfig {
        name: detect_project_name(project_path),
        processes: guess_processes(project_path),
    };

    let yaml = serde_yaml::to_string(&config).map_err(|err| err.to_string())?;
    std::fs::write(&config_path, yaml)
        .map_err(|err| format!("{} ({})", err, config_path.display()))?;

    Ok(config)
}

#[tauri::command(rename_all = "camelCase")]
fn read_project_config_file(path: String) -> Result<ConfigFilePayload, String> {
    let project_path = Path::new(&path);
    let config_path = find_existing_config_path(project_path)
        .ok_or_else(|| "Missing myterm.yml".to_string())?;
    let contents = fs::read_to_string(&config_path)
        .map_err(|err| format!("{} ({})", err, config_path.display()))?;
    Ok(ConfigFilePayload {
        path: config_path.to_string_lossy().to_string(),
        contents,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn write_project_config_file(path: String, contents: String) -> Result<(), String> {
    let project_path = Path::new(&path);
    let config_path = find_existing_config_path(project_path)
        .unwrap_or_else(|| project_path.join("myterm.yml"));

    fs::write(&config_path, contents)
        .map_err(|err| format!("{} ({})", err, config_path.display()))?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn start_process(
    app: AppHandle,
    state: State<ProcessManager>,
    project_path: String,
    process_name: String,
    command: String,
    autorestart: bool,
) -> Result<(), String> {
    let key = process_key(&project_path, &process_name);
    let manager = state.inner().clone();

    {
        let mut map = manager
            .processes
            .lock()
            .map_err(|_| "Process map poisoned".to_string())?;
        if map.contains_key(&key) {
            return Err("Process already running".to_string());
        }
        map.insert(
            key.clone(),
            ManagedProcess {
                pid: 0,
                stop_flag: Arc::new(AtomicBool::new(false)),
                stdin: Arc::new(Mutex::new(None)),
            },
        );
    }

    let app_handle = app.clone();
    thread::spawn(move || {
        let stop_flag = {
            let map = manager.processes.lock().ok();
            map.and_then(|map| map.get(&key).map(|p| p.stop_flag.clone()))
        };

        let Some(stop_flag) = stop_flag else {
            return;
        };

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            let mut cmd = Command::new(&shell);
            cmd.arg("-ilc")
                .arg(&command)
                .current_dir(&project_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                unsafe {
                    cmd.pre_exec(|| {
                        // Put the shell in its own process group so we can stop the entire tree.
                        // (setpgid(0, 0) => pgid = pid)
                        libc::setpgid(0, 0);
                        Ok(())
                    });
                }
            }

            let mut child = match cmd.spawn() {
                Ok(child) => child,
                Err(err) => {
                    emit_log(
                        &app_handle,
                        &project_path,
                        &process_name,
                        format!("Failed to start: {}", err),
                        "stderr",
                    );
                    emit_status(&app_handle, &project_path, &process_name, "crashed");

                    if !autorestart {
                        break;
                    }

                    thread::sleep(Duration::from_secs(1));
                    continue;
                }
            };

            let pid = child.id();
            if let Ok(mut map) = manager.processes.lock() {
                if let Some(entry) = map.get_mut(&key) {
                    entry.pid = pid;
                    if let Some(stdin) = child.stdin.take() {
                        if let Ok(mut handle) = entry.stdin.lock() {
                            *handle = Some(stdin);
                        }
                    }
                }
            }

            emit_status(&app_handle, &project_path, &process_name, "running");

            if let Some(stdout) = child.stdout.take() {
                spawn_log_reader(
                    app_handle.clone(),
                    project_path.clone(),
                    process_name.clone(),
                    "stdout",
                    stdout,
                );
            }

            if let Some(stderr) = child.stderr.take() {
                spawn_log_reader(
                    app_handle.clone(),
                    project_path.clone(),
                    process_name.clone(),
                    "stderr",
                    stderr,
                );
            }

            let status = child.wait();

            if let Ok(mut map) = manager.processes.lock() {
                if let Some(entry) = map.get_mut(&key) {
                    if let Ok(mut handle) = entry.stdin.lock() {
                        *handle = None;
                    }
                }
            }

            match status {
                Ok(status) => {
                    if let Some(code) = status.code() {
                        emit_log(
                            &app_handle,
                            &project_path,
                            &process_name,
                            format!("[exit] code {}", code),
                            "stdout",
                        );
                    } else {
                        emit_log(
                            &app_handle,
                            &project_path,
                            &process_name,
                            "[exit] terminated by signal".to_string(),
                            "stdout",
                        );
                    }
                }
                Err(err) => {
                    emit_log(
                        &app_handle,
                        &project_path,
                        &process_name,
                        format!("[exit] wait failed: {}", err),
                        "stderr",
                    );
                }
            }

            if stop_flag.load(Ordering::SeqCst) {
                emit_status(&app_handle, &project_path, &process_name, "stopped");
                break;
            }

            emit_status(&app_handle, &project_path, &process_name, "crashed");

            if !autorestart {
                break;
            }

            thread::sleep(Duration::from_secs(1));
        }

        if let Ok(mut map) = manager.processes.lock() {
            map.remove(&key);
        }
    });

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn stop_process(
    state: State<ProcessManager>,
    project_path: String,
    process_name: String,
) -> Result<(), String> {
    let key = process_key(&project_path, &process_name);
    let manager = state.inner().clone();

    let (pid, stop_flag) = {
        let map = manager
            .processes
            .lock()
            .map_err(|_| "Process map poisoned".to_string())?;
        let Some(entry) = map.get(&key) else {
            return Err("Process not running".to_string());
        };
        (entry.pid, entry.stop_flag.clone())
    };

    stop_flag.store(true, Ordering::SeqCst);

    #[cfg(unix)]
    {
        // Gracefully stop the whole process tree.
        signal_process_group(pid, libc::SIGTERM);

        // If it doesn't die quickly, force kill.
        let manager = manager.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(3));
            let pid = {
                let map = manager.processes.lock().ok();
                map.and_then(|map| map.get(&key).map(|p| p.pid)).unwrap_or(pid)
            };
            if process_group_exists(pid) {
                signal_process_group(pid, libc::SIGKILL);
            }
        });
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn write_to_process(
    state: State<ProcessManager>,
    project_path: String,
    process_name: String,
    input: String,
) -> Result<(), String> {
    let key = process_key(&project_path, &process_name);
    let stdin = {
        let map = state
            .processes
            .lock()
            .map_err(|_| "Process map poisoned".to_string())?;
        let Some(entry) = map.get(&key) else {
            return Err("Process not running".to_string());
        };
        entry.stdin.clone()
    };

    let mut handle = stdin
        .lock()
        .map_err(|_| "Process stdin poisoned".to_string())?;
    if let Some(stdin) = handle.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|err| format!("Failed to write to stdin: {}", err))?;
        stdin
            .flush()
            .map_err(|err| format!("Failed to flush stdin: {}", err))?;
        Ok(())
    } else {
        Err("Process stdin not available".to_string())
    }
}

#[tauri::command(rename_all = "camelCase")]
fn check_for_update(app: AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let output = Command::new("curl")
        .args(["-sL", "-H", "Accept: application/vnd.github+json",
               "https://api.github.com/repos/porterabbott/myterm/releases/latest"])
        .output()
        .map_err(|err| format!("Failed to fetch updates: {}", err))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh api failed: {}", stderr.trim()));
    }

    let release: GithubRelease =
        serde_json::from_slice(&output.stdout).map_err(|err| err.to_string())?;
    let latest_tag = release.tag_name.clone();
    let latest_version = latest_tag.trim_start_matches('v');
    let available = is_newer_version(latest_version, &current_version);

    let download_url = if available {
        release
            .assets
            .iter()
            .find(|asset| asset.name == "MyTerm.zip")
            .map(|asset| asset.browser_download_url.clone())
            .ok_or_else(|| "Update available, but MyTerm.zip asset not found".to_string())?
    } else {
        String::new()
    };

    Ok(UpdateInfo {
        available,
        version: latest_tag,
        download_url,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn install_update(download_url: String) -> Result<(), String> {
    if download_url.trim().is_empty() {
        return Err("Missing download URL".to_string());
    }

    let app_bundle = find_app_bundle_path()?;
    let _app_parent = app_bundle
        .parent()
        .ok_or_else(|| "Could not determine app bundle parent".to_string())?;

    let temp_dir = create_temp_dir()?;
    let zip_path = temp_dir.join("MyTerm.zip");
    let extract_dir = temp_dir.join("extract");
    fs::create_dir_all(&extract_dir).map_err(|err| err.to_string())?;

    // Use gh CLI to download the asset (handles auth for private repos)
    let dl_status = Command::new("curl")
        .args(["-sL", "-o"])
        .arg(&zip_path)
        .arg(&download_url)
        .status()
        .map_err(|err| format!("Failed to run gh CLI: {}", err))?;

    if !dl_status.success() {
        return Err("gh release download failed".to_string());
    }

    let unzip_status = Command::new("unzip")
        .arg("-q")
        .arg(&zip_path)
        .arg("-d")
        .arg(&extract_dir)
        .status()
        .map_err(|err| err.to_string())?;

    if !unzip_status.success() {
        return Err("Failed to unzip update".to_string());
    }

    let extracted_app = find_app_in_dir(&extract_dir)
        .ok_or_else(|| "Could not locate extracted .app bundle".to_string())?;

    let _ = Command::new("xattr")
        .arg("-cr")
        .arg(&extracted_app)
        .status();

    // Move old bundle aside (keeps running binary intact), copy new one in, then clean up
    let backup_bundle = app_bundle.with_extension("app.old");
    let _ = Command::new("rm").args(["-rf"]).arg(&backup_bundle).status();

    let mv_status = Command::new("mv")
        .arg(&app_bundle)
        .arg(&backup_bundle)
        .status()
        .map_err(|err| err.to_string())?;

    if !mv_status.success() {
        return Err("Failed to move old app bundle".to_string());
    }

    let copy_status = Command::new("cp")
        .args(["-R"])
        .arg(&extracted_app)
        .arg(&app_bundle)
        .status()
        .map_err(|err| err.to_string())?;

    if !copy_status.success() {
        return Err("Failed to copy new app bundle".to_string());
    }

    let _ = Command::new("xattr")
        .arg("-cr")
        .arg(&app_bundle)
        .status();

    Ok(())
}

fn spawn_restart_helper(app_bundle: &Path, backup_bundle: &Path) -> Result<(), String> {
    let temp_dir = create_temp_dir()?;
    let script_path = temp_dir.join("restart.sh");
    let script = r#"#!/bin/sh
TARGET_PID="$MYTERM_PID"
APP_BUNDLE="$MYTERM_APP"
BACKUP_BUNDLE="$MYTERM_BACKUP"

i=0
while [ $i -lt 15 ]; do
  if ! kill -0 "$TARGET_PID" 2>/dev/null; then
    break
  fi
  sleep 0.1
  i=$((i+1))
done

sleep 0.5
/usr/bin/open -n "$APP_BUNDLE" >/dev/null 2>&1
sleep 1
/bin/rm -rf "$BACKUP_BUNDLE" >/dev/null 2>&1
"#;

    fs::write(&script_path, script).map_err(|err| err.to_string())?;

    let mut cmd = Command::new("/bin/sh");
    cmd.arg(&script_path)
        .env("MYTERM_PID", format!("{}", std::process::id()))
        .env("MYTERM_APP", app_bundle)
        .env("MYTERM_BACKUP", backup_bundle)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn().map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn restart_app(app: AppHandle, state: State<RestartState>) -> Result<(), String> {
    let running_bundle = find_app_bundle_path()?;
    let app_bundle = resolve_primary_app_bundle_path(&running_bundle);
    let backup_bundle = app_bundle.with_extension("app.old");

    if !app_bundle.exists() {
        return Err(format!(
            "Updated app bundle not found at {}",
            app_bundle.display()
        ));
    }

    spawn_restart_helper(&app_bundle, &backup_bundle)?;
    state.mark_update_restart();
    // Hard exit — bypass all Tauri cleanup to avoid hangs
    // The setsid helper script survives this and relaunches the app
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessManager::default())
        .manage(RestartState::default())
        .invoke_handler(tauri::generate_handler![
            load_project_config,
            init_project_config,
            read_project_config_file,
            write_project_config_file,
            start_process,
            stop_process,
            write_to_process,
            check_for_update,
            install_update,
            restart_app
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let restart_state = app_handle.state::<RestartState>();
                if restart_state.should_skip_cleanup() {
                    return;
                }

                // Ensure we don't leave orphaned dev servers running.
                api.prevent_exit();

                let manager = app_handle.state::<ProcessManager>();
                let pgids = stop_all_processes(manager.inner());

                #[cfg(unix)]
                {
                    wait_then_force_kill(pgids, Duration::from_millis(800), Duration::from_millis(800));
                }

                app_handle.exit(0);
            }
        });
}
