import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type ProcessStatus = "running" | "stopped" | "crashed";

type ProcessConfig = {
  name: string;
  command: string;
  autostart?: boolean;
  autorestart?: boolean;
};

type ProjectConfig = {
  name: string;
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
    // Load persisted projects on mount
    const paths = loadProjectPaths();
    paths.forEach((path) => {
      loadProjectAtPath(path, false);
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

  const handleReloadConfig = async (project: ProjectView) => {
    setError(null);
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
            processes: updatedProcesses,
            configError: undefined,
          };
        })
      );
    } catch (err) {
      setError(`Failed to reload config: ${String(err)}`);
    }
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
        </aside>

        <main className="flex flex-1 flex-col overflow-hidden">
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
                      <button
                        onClick={() => handleCreateConfig(selectedProject)}
                        className="text-emerald-400 hover:text-emerald-300 transition"
                        title="Create myterm.yml"
                      >
                        Create config
                      </button>
                    ) : (
                      <button
                        onClick={() => handleReloadConfig(selectedProject)}
                        className="text-slate-400 hover:text-slate-300 transition"
                        title="Reload myterm.yml"
                      >
                        Reload
                      </button>
                    )}
                  </div>
                </div>
                {!selectedProject.configError && (
                  <div className="flex gap-2">
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
                    <pre className="flex-1 overflow-y-auto bg-slate-950 px-6 py-4 text-xs leading-relaxed text-slate-100 font-mono">
                      {selectedProcess && selectedProcess.logs.length > 0
                        ? selectedProcess.logs.join("\n")
                        : "No logs yet."}
                    </pre>
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
        </main>
      </div>
    </div>
  );
}
