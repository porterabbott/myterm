import { useEffect, useMemo, useRef, useState } from "react";
import AnsiToHtml from "ansi-to-html";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";

type ProcessStatus = "running" | "stopped" | "crashed";

type ProcessConfig = {
  name: string;
  command: string;
  autostart?: boolean;
  autorestart?: boolean;
};

type ActionConfig = {
  name: string;
  command: string;
};

type ProjectConfig = {
  name: string;
  actions?: ActionConfig[];
  processes: ProcessConfig[];
};

type ProcessView = ProcessConfig & {
  status: ProcessStatus;
  logs: string[];
};

type ProjectView = {
  id: string;
  name: string;
  path: string;
  actions: ActionConfig[];
  processes: ProcessView[];
  configError?: string;
};

type LogEvent = {
  project_path: string;
  process_name: string;
  line: string;
  stream: string;
};

type StatusEvent = {
  project_path: string;
  process_name: string;
  status: ProcessStatus;
};

type UpdateCheckResult = {
  available: boolean;
  version: string;
  downloadUrl: string;
};

type ConfigFilePayload = {
  path: string;
  contents: string;
};

const statusDot: Record<ProcessStatus, string> = {
  running: "bg-emerald-500",
  crashed: "bg-red-500",
  stopped: "bg-slate-500",
};

const STORAGE_KEY = "myterm-projects";

function saveProjects(paths: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
}

function loadProjectPaths(): string[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedProcessName, setSelectedProcessName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoScrollLogs, setAutoScrollLogs] = useState(true);
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "available" | "downloading" | "restart"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState<string | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [configEditorPath, setConfigEditorPath] = useState<string | null>(null);
  const [configEditorContent, setConfigEditorContent] = useState("");
  const [configEditorError, setConfigEditorError] = useState<string | null>(null);
  const [configEditorLoading, setConfigEditorLoading] = useState(false);
  const [configEditorSaving, setConfigEditorSaving] = useState(false);

  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const ansiConverter = useMemo(
    () =>
      new AnsiToHtml({
        fg: "#e2e8f0",
        bg: "#0f172a",
        escapeXML: true,
        newline: true,
      }),
    []
  );

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const selectedProcess = useMemo(() => {
    if (!selectedProject || !selectedProcessName) return null;
    return (
      selectedProject.processes.find(
        (process) => process.name === selectedProcessName
      ) || null
    );
  }, [selectedProject, selectedProcessName]);

  const logHtml = useMemo(() => {
    if (!selectedProcess || selectedProcess.logs.length === 0) return "";
    return ansiConverter.toHtml(selectedProcess.logs.join("\n"));
  }, [ansiConverter, selectedProcess]);

  const canSendInput = !!selectedProcess && selectedProcess.status === "running";

  useEffect(() => {
    const unlistenLog = listen<LogEvent>("process-log", (event) => {
      setProjects((prev) =>
        prev.map((project) => {
          if (project.path !== event.payload.project_path) return project;
          return {
            ...project,
            processes: project.processes.map((process) => {
              if (process.name !== event.payload.process_name) return process;
              const line =
                event.payload.stream === "stderr"
                  ? `[stderr] ${event.payload.line}`
                  : event.payload.line;
              const nextLogs = [...process.logs, line].slice(-500);
              return { ...process, logs: nextLogs };
            }),
          };
        })
      );
    });

    const unlistenStatus = listen<StatusEvent>("process-status", (event) => {
      setProjects((prev) =>
        prev.map((project) => {
          if (project.path !== event.payload.project_path) return project;
          return {
            ...project,
            processes: project.processes.map((process) => {
              if (process.name !== event.payload.process_name) return process;
              return { ...process, status: event.payload.status };
            }),
          };
        })
      );
    });

    return () => {
      unlistenLog.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    if (!selectedProcessName && selectedProject.processes.length > 0) {
      setSelectedProcessName(selectedProject.processes[0].name);
    }
  }, [selectedProject, selectedProcessName]);

  useEffect(() => {
    if (!autoScrollLogs) return;
    if (!logContainerRef.current) return;
    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [autoScrollLogs, logHtml]);

  useEffect(() => {
    // Load persisted projects on mount
    const paths = loadProjectPaths();
    paths.forEach((path) => {
      loadProjectAtPath(path, false);
    });
  }, []);

  useEffect(() => {
    setConfigEditorOpen(false);
    setConfigEditorError(null);
    setConfigEditorPath(null);
    setConfigEditorContent("");
    setConfigEditorLoading(false);
    setConfigEditorSaving(false);
  }, [selectedProjectId]);

  useEffect(() => {
    getVersion()
      .then((version) => setCurrentVersion(version))
      .catch(() => {
        setCurrentVersion("");
      });
  }, []);

  const startProcess = async (project: ProjectView, process: ProcessView) => {
    setError(null);
    try {
      await invoke("start_process", {
        projectPath: project.path,
        processName: process.name,
        command: process.command,
        autorestart: !!process.autorestart,
      });
    } catch (err) {
      setError(`Failed to start ${process.name}: ${String(err)}`);
    }
  };

  const stopProcess = async (project: ProjectView, process: ProcessView) => {
    setError(null);
    try {
      await invoke("stop_process", {
        projectPath: project.path,
        processName: process.name,
      });
    } catch (err) {
      setError(`Failed to stop ${process.name}: ${String(err)}`);
    }
  };

  const loadProjectAtPath = async (path: string, saveToStorage = true) => {
    const existing = projects.find((project) => project.path === path);
    if (existing) {
      setSelectedProjectId(existing.id);
      return;
    }

    try {
      const config = await invoke<ProjectConfig>("load_project_config", { path });
      const project: ProjectView = {
        id: path,
        path,
        name: config.name || path,
        actions: config.actions ?? [],
        processes: config.processes.map((process) => ({
          ...process,
          status: "stopped",
          logs: [],
        })),
      };

      setProjects((prev) => {
        const updated = [...prev, project];
        if (saveToStorage) {
          saveProjects(updated.map((p) => p.path));
        }
        return updated;
      });
      setSelectedProjectId(project.id);
      setSelectedProcessName(project.processes[0]?.name ?? null);

      if (project.processes.some((process) => process.autostart)) {
        setTimeout(() => {
          project.processes
            .filter((process) => process.autostart)
            .forEach((process) => startProcess(project, process));
        }, 0);
      }
    } catch (err) {
      const errorMsg = String(err);
      const project: ProjectView = {
        id: path,
        path,
        name: path.split("/").pop() || "unknown",
        actions: [],
        processes: [],
        configError: errorMsg,
      };

      setProjects((prev) => {
        const updated = [...prev, project];
        if (saveToStorage) {
          saveProjects(updated.map((p) => p.path));
        }
        return updated;
      });
      setSelectedProjectId(project.id);
      setError(`Could not load config for ${path}: ${errorMsg}`);
    }
  };

  const handleAddProject = async () => {
    setError(null);
    const selected = await open({ directory: true, multiple: false });
    if (!selected) return;
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path) return;

    await loadProjectAtPath(path);
  };

  const handleRemoveProject = async (projectId: string) => {
    const project = projects.find((p) => p.id === projectId);
    if (!project) return;

    // Stop all running processes first
    const runningProcesses = project.processes.filter((p) => p.status === "running");
    for (const process of runningProcesses) {
      await stopProcess(project, process);
    }

    setProjects((prev) => {
      const updated = prev.filter((p) => p.id !== projectId);
      saveProjects(updated.map((p) => p.path));
      return updated;
    });

    if (selectedProjectId === projectId) {
      setSelectedProjectId(null);
      setSelectedProcessName(null);
    }
  };

  const handleOpenInFinder = async (path: string) => {
    try {
      await openPath(path);
    } catch (err) {
      setError(`Failed to open in Finder: ${String(err)}`);
    }
  };

  const handleCreateConfig = async (project: ProjectView) => {
    setError(null);
    try {
      const config = await invoke<ProjectConfig>("init_project_config", {
        path: project.path,
      });

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== project.id) return p;
          return {
            ...p,
            name: config.name,
            actions: config.actions ?? [],
            processes: config.processes.map((process) => ({
              ...process,
              status: "stopped",
              logs: [],
            })),
            configError: undefined,
          };
        })
      );

      setSelectedProcessName(config.processes[0]?.name ?? null);
    } catch (err) {
      setError(`Failed to create config: ${String(err)}`);
    }
  };

  const reloadProjectConfig = async (project: ProjectView) => {
    try {
      const config = await invoke<ProjectConfig>("load_project_config", {
        path: project.path,
      });

      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== project.id) return p;

          // Keep existing logs and status for matching processes
          const updatedProcesses = config.processes.map((newProc) => {
            const existing = p.processes.find((ep) => ep.name === newProc.name);
            return {
              ...newProc,
              status: existing?.status ?? ("stopped" as ProcessStatus),
              logs: existing?.logs ?? [],
            };
          });

          return {
            ...p,
            name: config.name,
            actions: config.actions ?? [],
            processes: updatedProcesses,
            configError: undefined,
          };
        })
      );
      return true;
    } catch (err) {
      setError(`Failed to reload config: ${String(err)}`);
      return false;
    }
  };

  const handleReloadConfig = async (project: ProjectView) => {
    setError(null);
    await reloadProjectConfig(project);
  };

  const handleStartAll = () => {
    if (!selectedProject) return;
    selectedProject.processes
      .filter((process) => process.status !== "running")
      .forEach((process) => startProcess(selectedProject, process));
  };

  const handleStopAll = () => {
    if (!selectedProject) return;
    selectedProject.processes
      .filter((process) => process.status === "running")
      .forEach((process) => stopProcess(selectedProject, process));
  };

  const handleRunAction = async (project: ProjectView, action: ActionConfig) => {
    setError(null);
    try {
      await invoke("run_action", {
        projectPath: project.path,
        command: action.command,
      });
    } catch (err) {
      setError(`Failed to run action "${action.name}": ${String(err)}`);
    }
  };

  const handleClearLogs = () => {
    if (!selectedProject || !selectedProcessName) return;
    setProjects((prev) =>
      prev.map((project) => {
        if (project.id !== selectedProject.id) return project;
        return {
          ...project,
          processes: project.processes.map((process) => {
            if (process.name !== selectedProcessName) return process;
            return { ...process, logs: [] };
          }),
        };
      })
    );
  };

  const handleSendInput = async () => {
    if (!selectedProject || !selectedProcess) return;
    if (selectedProcess.status !== "running") return;

    setError(null);
    try {
      const payload = `${terminalInput}\n`;
      await invoke("write_to_process", {
        projectPath: selectedProject.path,
        processName: selectedProcess.name,
        input: payload,
      });
      setTerminalInput("");
    } catch (err) {
      setError(`Failed to send input to ${selectedProcess.name}: ${String(err)}`);
    }
  };

  const handleOpenConfigEditor = async () => {
    if (!selectedProject) return;
    setConfigEditorError(null);
    setConfigEditorContent("");
    setConfigEditorPath(`${selectedProject.path}/myterm.yml`);
    setConfigEditorOpen(true);
    setConfigEditorLoading(true);

    try {
      const result = await invoke<ConfigFilePayload>(
        "read_project_config_file",
        {
          path: selectedProject.path,
        }
      );
      setConfigEditorPath(result.path);
      setConfigEditorContent(result.contents);
    } catch (err) {
      setConfigEditorError(`Failed to load config: ${String(err)}`);
    } finally {
      setConfigEditorLoading(false);
    }
  };

  const handleSaveConfigEditor = async () => {
    if (!selectedProject) return;
    setConfigEditorError(null);
    setConfigEditorSaving(true);

    try {
      await invoke("write_project_config_file", {
        path: selectedProject.path,
        contents: configEditorContent,
      });
      const ok = await reloadProjectConfig(selectedProject);
      if (ok) {
        setConfigEditorOpen(false);
      }
    } catch (err) {
      setConfigEditorError(`Failed to save config: ${String(err)}`);
    } finally {
      setConfigEditorSaving(false);
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateError(null);
    setUpdateNote(null);
    setUpdateStatus("checking");

    try {
      const result = await invoke<UpdateCheckResult>("check_for_update");
      if (result.available) {
        setUpdateStatus("available");
        setUpdateVersion(result.version);
        setUpdateDownloadUrl(result.downloadUrl);
        setUpdateNote(null);
      } else {
        setUpdateStatus("idle");
        setUpdateVersion(null);
        setUpdateDownloadUrl(null);
        setUpdateNote("You're up to date.");
      }
    } catch (err) {
      setUpdateStatus("idle");
      setUpdateError(`Update check failed: ${String(err)}`);
    }
  };

  const handleUpdateNow = async () => {
    if (!updateDownloadUrl) return;
    setUpdateError(null);
    setUpdateStatus("downloading");

    try {
      await invoke("install_update", { downloadUrl: updateDownloadUrl });
      setUpdateStatus("restart");
      setUpdateNote(null);
    } catch (err) {
      setUpdateStatus("available");
      setUpdateError(`Update failed: ${String(err)}`);
    }
  };

  const handleRestartApp = async () => {
    setUpdateError(null);
    try {
      await invoke("restart_app");
    } catch (err) {
      setUpdateError(`Restart failed: ${String(err)}`);
    }
  };

  return (
    <div className="h-screen w-screen bg-slate-950 text-slate-100 flex flex-col">
      <div className="flex flex-1 overflow-hidden">
        <aside className="w-64 border-r border-slate-800 bg-slate-900/50 p-4 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-lg font-semibold">MyTerm</h1>
            <button
              onClick={handleAddProject}
              className="rounded-md bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500 transition"
              title="Add project"
            >
              + Add
            </button>
          </div>
          <div className="flex-1 space-y-1 overflow-y-auto">
            {projects.length === 0 ? (
              <p className="text-xs text-slate-400 mt-2">
                Add a project to get started.
              </p>
            ) : (
              projects.map((project) => (
                <div
                  key={project.id}
                  className={`group relative rounded-md px-2 py-2 text-left text-sm transition cursor-pointer ${
                    project.id === selectedProjectId
                      ? "bg-slate-800 text-white"
                      : "text-slate-300 hover:bg-slate-800/60"
                  }`}
                  onClick={() => {
                    setSelectedProjectId(project.id);
                    setSelectedProcessName(project.processes[0]?.name ?? null);
                  }}
                >
                  <div className="font-medium flex items-center gap-2">
                    {project.name}
                    {project.configError && (
                      <span className="text-[10px] bg-red-500/20 text-red-300 px-1 py-0.5 rounded">
                        no config
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-400 truncate pr-6">
                    {project.path}
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRemoveProject(project.id);
                    }}
                    className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition text-slate-400 hover:text-red-400"
                    title="Remove project"
                  >
                    ×
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-4 border-t border-slate-800 pt-3 text-xs text-slate-400">
            <div className="flex items-center justify-between">
              <span className="text-slate-500">
                {currentVersion ? `v${currentVersion}` : ""}
              </span>
              <button
                onClick={handleCheckForUpdates}
                disabled={
                  updateStatus === "checking" || updateStatus === "downloading"
                }
                className="text-emerald-400 hover:text-emerald-300 disabled:opacity-40 transition"
                title="Check for updates"
              >
                {updateStatus === "checking" ? "Checking…" : "Check updates"}
              </button>
            </div>

            {updateStatus === "available" && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-emerald-300 truncate">
                  Update available: {updateVersion}
                </span>
                <button
                  onClick={handleUpdateNow}
                  className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500 transition"
                >
                  Update now
                </button>
              </div>
            )}

            {updateStatus === "downloading" && (
              <div className="mt-2 text-slate-500">Downloading update…</div>
            )}

            {updateStatus === "restart" && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-emerald-300">Restart to finish update</span>
                <button
                  onClick={handleRestartApp}
                  className="rounded-md bg-emerald-600 px-2 py-1 text-[10px] font-semibold text-white hover:bg-emerald-500 transition"
                >
                  Restart
                </button>
              </div>
            )}

            {updateNote && updateStatus === "idle" && (
              <div className="mt-2 text-slate-500">{updateNote}</div>
            )}

            {updateError && (
              <div className="mt-2 text-red-400">{updateError}</div>
            )}
          </div>
        </aside>

        <main className="relative flex flex-1 flex-col overflow-hidden">
          {selectedProject ? (
            <>
              <header className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
                <div>
                  <div className="text-xl font-semibold">{selectedProject.name}</div>
                  <div className="text-xs text-slate-400 flex items-center gap-3">
                    <span>{selectedProject.path}</span>
                    <button
                      onClick={() => handleOpenInFinder(selectedProject.path)}
                      className="text-emerald-400 hover:text-emerald-300 transition"
                      title="Open in Finder"
                    >
                      Open →
                    </button>
                    {selectedProject.configError ? (
                      <>
                        <button
                          onClick={() => handleCreateConfig(selectedProject)}
                          className="text-emerald-400 hover:text-emerald-300 transition"
                          title="Create myterm.yml"
                        >
                          Create config
                        </button>
                        <button
                          onClick={handleOpenConfigEditor}
                          className="text-slate-400 hover:text-slate-300 transition"
                          title="Edit myterm.yml"
                        >
                          Edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleReloadConfig(selectedProject)}
                          className="text-slate-400 hover:text-slate-300 transition"
                          title="Reload myterm.yml"
                        >
                          Reload
                        </button>
                        <button
                          onClick={handleOpenConfigEditor}
                          className="text-slate-400 hover:text-slate-300 transition"
                          title="Edit myterm.yml"
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {!selectedProject.configError && (
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      onClick={handleStartAll}
                      className="rounded-md border border-emerald-500 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/20 transition"
                    >
                      Start all
                    </button>
                    <button
                      onClick={handleStopAll}
                      className="rounded-md border border-red-500 px-3 py-1 text-xs font-semibold text-red-200 hover:bg-red-500/20 transition"
                    >
                      Stop all
                    </button>
                    {selectedProject.actions.map((action) => (
                      <button
                        key={action.name}
                        onClick={() => handleRunAction(selectedProject, action)}
                        className="max-w-44 truncate rounded-md border border-slate-500/60 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-500/10 transition"
                        title={action.command}
                      >
                        {action.name}
                      </button>
                    ))}
                  </div>
                )}
              </header>

              {error ? (
                <div className="border-b border-red-500/50 bg-red-500/10 px-6 py-2 text-xs text-red-200 flex items-center justify-between">
                  <span>{error}</span>
                  <button
                    onClick={() => setError(null)}
                    className="text-red-300 hover:text-red-200"
                  >
                    ×
                  </button>
                </div>
              ) : null}

              {selectedProject.configError ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center max-w-md">
                    <div className="text-slate-400 mb-4">
                      No <code className="bg-slate-800 px-1 py-0.5 rounded text-xs">myterm.yml</code> found in this project.
                    </div>
                    <button
                      onClick={() => handleCreateConfig(selectedProject)}
                      className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 transition"
                    >
                      Create config
                    </button>
                    <div className="text-xs text-slate-500 mt-3">
                      We'll auto-detect processes from package.json or Procfile
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex flex-1 overflow-hidden">
                  <div className="w-1/2 overflow-y-auto border-r border-slate-800 p-6 space-y-4">
                    {selectedProject.processes.map((process) => (
                      <div
                        key={process.name}
                        onClick={() => setSelectedProcessName(process.name)}
                        className={`cursor-pointer rounded-lg border p-4 transition ${
                          selectedProcessName === process.name
                            ? "border-emerald-400/60 bg-slate-900"
                            : "border-slate-800 bg-slate-900/40 hover:border-slate-600"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={`h-2 w-2 rounded-full ${statusDot[process.status]}`}
                            />
                            <span className="font-semibold">{process.name}</span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                startProcess(selectedProject, process);
                              }}
                              disabled={process.status === "running"}
                              className="rounded-md border border-emerald-500/60 px-2 py-1 text-xs text-emerald-200 disabled:opacity-40 hover:bg-emerald-500/20 transition"
                            >
                              Start
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                stopProcess(selectedProject, process);
                              }}
                              disabled={process.status !== "running"}
                              className="rounded-md border border-red-500/60 px-2 py-1 text-xs text-red-200 disabled:opacity-40 hover:bg-red-500/20 transition"
                            >
                              Stop
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 text-xs text-slate-300 font-mono bg-slate-950/50 px-2 py-1 rounded">
                          {process.command}
                        </div>
                        <div className="mt-2 text-[11px] text-slate-500 flex gap-3">
                          <span>Autostart: {process.autostart ? "on" : "off"}</span>
                          <span>Autorestart: {process.autorestart ? "on" : "off"}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex w-1/2 flex-col">
                    <div className="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
                      <div>
                        <div className="text-sm font-semibold">Logs</div>
                        <div className="text-xs text-slate-400">
                          {selectedProcess ? selectedProcess.name : "Select a process"}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoScrollLogs}
                            onChange={(e) => setAutoScrollLogs(e.target.checked)}
                            className="rounded"
                          />
                          Auto-scroll
                        </label>
                        <button
                          onClick={handleClearLogs}
                          disabled={!selectedProcess || selectedProcess.logs.length === 0}
                          className="text-xs text-slate-400 hover:text-slate-300 disabled:opacity-40 transition"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div
                      ref={logContainerRef}
                      className="flex-1 overflow-y-auto bg-slate-950 px-6 py-4 text-xs leading-relaxed text-slate-100 font-mono"
                    >
                      {selectedProcess && selectedProcess.logs.length > 0 ? (
                        <div
                          className="whitespace-pre-wrap break-words"
                          dangerouslySetInnerHTML={{ __html: logHtml }}
                        />
                      ) : (
                        <div className="text-slate-500">No logs yet.</div>
                      )}
                    </div>
                    <div className="border-t border-slate-800 px-6 py-3 bg-slate-900/40">
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          handleSendInput();
                        }}
                        className="flex items-center gap-2"
                      >
                        <span className="text-xs text-slate-500 font-mono">›</span>
                        <input
                          type="text"
                          value={terminalInput}
                          onChange={(event) => setTerminalInput(event.target.value)}
                          disabled={!canSendInput}
                          placeholder={
                            canSendInput
                              ? "Type input and press Enter…"
                              : "Start the process to send input"
                          }
                          className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
                        />
                        <button
                          type="submit"
                          disabled={!canSendInput}
                          className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 transition"
                        >
                          Send
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center text-slate-400">
              <div className="text-center">
                <div className="text-lg mb-2">No project selected</div>
                <div className="text-sm">Add a project to get started</div>
              </div>
            </div>
          )}
          {configEditorOpen && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/80 p-6 backdrop-blur-sm">
              <div className="flex w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
                <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
                  <div>
                    <div className="text-sm font-semibold">Edit myterm.yml</div>
                    {configEditorPath && (
                      <div className="text-xs text-slate-400">{configEditorPath}</div>
                    )}
                  </div>
                  <button
                    onClick={() => setConfigEditorOpen(false)}
                    className="text-slate-400 hover:text-slate-200"
                    title="Close"
                  >
                    ×
                  </button>
                </div>
                <div className="flex-1 overflow-hidden p-4">
                  {configEditorLoading ? (
                    <div className="text-xs text-slate-400">Loading config…</div>
                  ) : (
                    <textarea
                      value={configEditorContent}
                      onChange={(event) => setConfigEditorContent(event.target.value)}
                      spellCheck={false}
                      className="h-72 w-full resize-none rounded-md border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  )}
                  {configEditorError && (
                    <div className="mt-2 text-xs text-red-400">{configEditorError}</div>
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
                  <span className="text-[11px] text-slate-500">
                    Saves to disk and reloads the config.
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setConfigEditorOpen(false)}
                      className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 transition"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveConfigEditor}
                      disabled={configEditorSaving || configEditorLoading}
                      className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40 transition"
                    >
                      {configEditorSaving ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
