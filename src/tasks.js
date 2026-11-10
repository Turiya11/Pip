/**
 * Parked thoughts, stored the same way as the Pip web app (same key and task shape),
 * so data exported from one build reads in the other. localStorage is per site, though:
 * thoughts parked on another Pip link do not appear here.
 */
const STORAGE_KEY = 'pip_thought_orbit_v8_stable';

let tasks = [];
const listeners = new Set();

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
    if (raw) tasks = JSON.parse(raw) || [];
  } catch (e) {
    tasks = [];
  }
  if (!Array.isArray(tasks)) tasks = [];
  // Seed the welcome thought only on a first visit, not after the user clears everything.
  if (raw === null) {
    tasks = [{ id: '1', title: 'Welcome to Pip Orbit', context: 'Exploring AR space', nextStep: 'Pinch the orb to inspect', completed: false, createdAt: Date.now() }];
  }
  tasks = tasks.filter((t) => t && t.title);
}
load();

// Returns false if the browser refused to store the data. `notify: false` saves without
// rebuilding the orbit (used for Focus Mode workspace edits).
function save({ notify = true } = {}) {
  let ok = true;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch (e) {
    ok = false; /* storage can be blocked; the session still works in memory */
  }
  if (notify) listeners.forEach((fn) => fn());
  return ok;
}

/*
 * Focus Mode workspace, stored on the thought itself (task.workspace) under the same
 * storage key, so there is one record per thought. The web app keeps unknown fields
 * when it reads a thought, so this is additive. Missing or invalid data becomes empty.
 */
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
function emptyWorkspace() {
  return { version: 1, stickies: [], childTasks: [], voiceNotes: [], connections: [], layout: { contextCollapsed: false }, openCount: 0, lastOpenedAt: null, updatedAt: null };
}
function normalizeWorkspace(w) {
  const base = emptyWorkspace();
  if (!w || typeof w !== 'object') return base;
  return {
    ...base,
    ...w,
    stickies: list(w.stickies),
    childTasks: list(w.childTasks),
    voiceNotes: list(w.voiceNotes),
    connections: list(w.connections),
    layout: { ...base.layout, ...(w.layout && typeof w.layout === 'object' ? w.layout : {}) },
    openCount: Number.isFinite(w.openCount) ? w.openCount : 0,
  };
}

const createdAt = (t) => [t.createdAt, Number(t.id)].find((v) => Number.isFinite(v) && v > 1e12) || 0;
const isDue = (t) => !t.completed && !t.archived && t.notified && t.remindAt != null;

export const Tasks = {
  /** Thoughts in the orbit: not completed or archived; resurfaced ones first. */
  orbit() {
    return tasks.filter((t) => !t.completed && !t.archived).sort((a, b) => (isDue(b) - isDue(a)) || (createdAt(a) - createdAt(b)));
  },
  completedCount() {
    return tasks.filter((t) => t.completed).length;
  },
  get(id) {
    return tasks.find((t) => t.id === id);
  },
  isDue,
  park(title) {
    const text = title.trim();
    if (!text) return null;
    const task = { id: String(Date.now()), title: text, context: '', nextStep: '', completed: false, createdAt: Date.now() };
    tasks.push(task);
    save();
    return task;
  },
  complete(id) {
    const t = this.get(id);
    if (!t) return;
    t.completed = true;
    t.completedAt = Date.now();
    save();
  },
  /** The thought's workspace (normalized copy; empty if it has none yet). */
  workspace(id) {
    const t = this.get(id);
    return normalizeWorkspace(t && t.workspace);
  },
  hasWorkspace(id) {
    const t = this.get(id);
    return !!(t && t.workspace && typeof t.workspace === 'object');
  },
  /** Apply `change(workspace)` and save. Returns the save time, or 0 if storage refused. */
  updateWorkspace(id, change) {
    const t = this.get(id);
    if (!t) return 0;
    const w = normalizeWorkspace(t.workspace);
    change(w);
    w.updatedAt = Date.now();
    t.workspace = w;
    return save({ notify: false }) ? w.updatedAt : 0;
  },
  childProgress(id) {
    const kids = this.workspace(id).childTasks;
    return { done: kids.filter((k) => k.completed).length, total: kids.length };
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
