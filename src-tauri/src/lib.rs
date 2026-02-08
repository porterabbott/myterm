use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
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

struct ManagedProcess {
    /// PID of the shell process we spawn. On Unix we also use this as the process group id (pgid)
    /// because we call `setpgid(0, 0)` in the child.
    pid: u32,
    stop_flag: Arc<AtomicBool>,
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(ProcessManager::default())
        .invoke_handler(tauri::generate_handler![
            load_project_config,
            init_project_config,
            start_process,
            stop_process
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
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
