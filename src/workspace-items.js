import {
  BufferGeometry,
  CanvasTexture,
  DistanceGrabbable,
  DoubleSide,
  DynamicDrawUsage,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  PlaneGeometry,
  RayInteractable,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { ChildTask, Sticky } from './pip-components.js';
import { Sound } from './sound.js';
import { Tasks } from './tasks.js';

/*
 * Focus Mode, phase 2: sticky notes and sub-tasks on the glass board.
 * Everything lives in the thought's workspace (task.workspace) and is saved on every change.
 * Positions are board-local metres (x right, y up, from the board centre).
 */

export const STICKY_COLOURS = {
  lavender: { card: 0xdcd3fb, css: '#dcd3fb' },
  yellow: { card: 0xf6ecb4, css: '#f6ecb4' },
  blue: { card: 0xc3d7ef, css: '#c3d7ef' },
  pink: { card: 0xf3cadb, css: '#f3cadb' },
};
const COLOUR_ORDER = ['lavender', 'yellow', 'blue', 'pink'];
// Sized for reading at the board's 1 m distance: sticky text is about 1.8 cm tall.
const STICKY_W = 0.18;
const STICKY_H = 0.12;
const CHILD_R = 0.026;
const LABEL_W = 0.23;
const BOUNDS = { minX: -0.49, maxX: 0.08, minY: -0.23, maxY: 0.14 }; // the thinking canvas
const MAX_TEXT = 120;
const MAX_LINES = 160;   // line segments drawn for links
const TAP_MOVE = 0.03;   // a drag shorter than this counts as a tap

const uid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function roundedRect(w, h, r) {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

function wrap(g, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (g.measureText(next).width <= maxWidth) { line = next; continue; }
    if (line) lines.push(line);
    line = w;
    while (g.measureText(line).width > maxWidth && line.length > 1) {
      let cut = line.length - 1;
      while (cut > 1 && g.measureText(line.slice(0, cut)).width > maxWidth) cut--;
      lines.push(line.slice(0, cut));
      line = line.slice(cut);
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, '') + '...';
  }
  return lines;
}

function stickyTexture(text) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 340;
  const g = c.getContext('2d');
  g.fillStyle = '#1f1838';
  g.font = '600 50px system-ui, -apple-system, Segoe UI, sans-serif';
  g.textBaseline = 'top';
  const lines = wrap(g, text, 456, 5);
  lines.forEach((l, i) => g.fillText(l, 28, 22 + i * 60));
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function labelTexture(text, done) {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 150;
  const g = c.getContext('2d');
  g.font = '600 50px system-ui, -apple-system, Segoe UI, sans-serif';
  g.textBaseline = 'middle';
  g.fillStyle = done ? '#9a93c9' : '#f5f4ff';
  const lines = wrap(g, done ? `Done: ${text}` : text, 620, 2);
  const top = lines.length === 1 ? 75 : 46;
  lines.forEach((l, i) => {
    g.fillText(l, 8, top + i * 56);
    if (done) {
      const w = g.measureText(l).width;
      g.fillRect(8, top + i * 56 + 2, w, 3);
    }
  });
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(5, 3, 20, 0.85)';
  g.shadowBlur = 26;
  g.fillStyle = 'rgba(5, 3, 20, 0.6)';
  g.fillRect(40, 40, 176, 112);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export class WorkspaceItems {
  constructor(focus) {
    this.focus = focus;
    this.sys = focus.sys;
    this.world = focus.world;
    this.front = focus.boardFront;
    this.taskId = null;
    this.ws = null;
    this.selected = null;     // { type: 'sticky' | 'child', id }
    this.mode = null;         // 'link' | 'move' | null
    this.editor = null;       // { kind, id, text }
    this.entities = new Map(); // key 'sticky:id' / 'child:id' -> entity
    this.lastTap = { key: '', at: 0 };
    this.v = new Vector3();
    this.v2 = new Vector3();

    this.cardGeo = new ExtrudeGeometry(roundedRect(STICKY_W, STICKY_H, 0.008), { depth: 0.004, bevelEnabled: false, curveSegments: 6 });
    this.textGeo = new PlaneGeometry(STICKY_W * 0.94, STICKY_H * 0.94);
    this.shadowGeo = new PlaneGeometry(STICKY_W * 256 / 176, STICKY_H * 192 / 112);
    this.shadowMat = new MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.8 });
    this.outlineGeo = new BufferGeometry().setFromPoints(roundedRect(STICKY_W + 0.012, STICKY_H + 0.012, 0.012).getPoints(10).map((p) => new Vector3(p.x, p.y, 0.006)));
    this.selectMat = new LineBasicMaterial({ color: 0x00d1c1 });
    this.childGeo = new SphereGeometry(CHILD_R, 32, 24);
    this.childRingGeo = new TorusGeometry(CHILD_R * 1.5, 0.002, 8, 48);
    this.labelGeo = new PlaneGeometry(LABEL_W, LABEL_W * 150 / 640);

    // Lines: parent -> sub-tasks, and between linked stickies.
    const positions = new Float32BufferAttribute(new Float32Array(MAX_LINES * 6), 3);
    positions.setUsage(DynamicDrawUsage);
    this.lineGeo = new BufferGeometry();
    this.lineGeo.setAttribute('position', positions);
    this.lineGeo.setDrawRange(0, 0);
    this.lines = new LineSegments(this.lineGeo, new LineBasicMaterial({ color: 0xc4b5fd, transparent: true, opacity: 0.55, depthWrite: false }));
    this.lines.name = 'Workspace Links';
    this.lines.frustumCulled = false;
    this.lines.raycast = () => {};
    focus.board.add(this.lines);

    this.actionsEntity = this.world.requireSceneEntity('item-actions');
    this.actions = this.world.requireSceneObject('item-actions');
    this.editorEntity = this.world.requireSceneEntity('note-editor');
    this.editorPanel = this.world.requireSceneObject('note-editor');
    this.sys.setPanel(this.actionsEntity, this.actions, false);
    this.sys.setPanel(this.editorEntity, this.editorPanel, false);
    this.wireActions();
    this.wireEditor();
  }

  get editorOpen() {
    return !!this.editor;
  }

  /* ---------- open / close ---------- */

  open(taskId) {
    this.taskId = taskId;
    this.ws = Tasks.workspace(taskId);
    this.selected = null;
    this.mode = null;
    this.render();
  }

  close() {
    this.closeEditor();
    this.select(null);
    this.mode = null;
    this.disposeItems();
    this.taskId = null;
    this.ws = null;
    this.lineGeo.setDrawRange(0, 0);
  }

  // Apply a change to the saved workspace, then redraw from what was saved.
  change(fn, { redraw = true } = {}) {
    const at = Tasks.updateWorkspace(this.taskId, fn);
    this.ws = Tasks.workspace(this.taskId);
    this.focus.showSaved(at);
    this.focus.refreshProgress();
    if (redraw) this.render();
    return at;
  }

  /* ---------- drawing ---------- */

  disposeItems() {
    this.entities.forEach((entity) => entity.dispose());
    this.entities.clear();
  }

  render() {
    this.disposeItems();
    if (!this.ws) return;
    for (const s of this.ws.stickies) this.entities.set(`sticky:${s.id}`, this.makeSticky(s));
    for (const c of this.ws.childTasks) this.entities.set(`child:${c.id}`, this.makeChild(c));
    if (this.selected && !this.find(this.selected.type, this.selected.id)) this.selected = null;
    this.select(this.selected, { silent: true });
    this.updateLines();
  }

  makeSticky(s) {
    const colour = STICKY_COLOURS[s.color] || STICKY_COLOURS.lavender;
    const card = new Mesh(this.cardGeo, new MeshStandardMaterial({ color: colour.card, roughness: 0.85, metalness: 0 }));
    card.name = `Sticky ${s.text}`;
    const text = new Mesh(this.textGeo, new MeshBasicMaterial({ map: stickyTexture(s.text), transparent: true, depthWrite: false }));
    text.position.z = 0.0045;
    text.raycast = () => {};
    const shadow = new Mesh(this.shadowGeo, this.shadowMat);
    shadow.position.set(0.004, -0.006, -0.002);
    shadow.raycast = () => {};
    const outline = new LineLoop(this.outlineGeo, this.selectMat);
    outline.visible = false;
    outline.raycast = () => {};
    card.add(text, shadow, outline);
    card.userData.outline = outline;
    card.position.set(s.x, s.y, this.front + 0.003);
    const entity = this.world.createTransformEntity(card, this.focus.boardEntity);
    entity.addComponent(Sticky, { noteId: s.id });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
    return entity;
  }

  makeChild(c) {
    const orb = new Mesh(this.childGeo, new MeshStandardMaterial({
      color: c.completed ? 0x5eead4 : 0xd8cbff,
      emissive: c.completed ? 0x0f766e : 0x6d28d9,
      emissiveIntensity: c.completed ? 0.5 : 0.7,
      roughness: 0.2,
    }));
    orb.name = `Sub-task ${c.title}`;
    const label = new Mesh(this.labelGeo, new MeshBasicMaterial({ map: labelTexture(c.title, c.completed), transparent: true, depthWrite: false, side: DoubleSide }));
    label.position.set(CHILD_R + 0.012 + LABEL_W / 2, 0, 0); // the label is part of the tap target
    const ring = new Mesh(this.childRingGeo, new MeshBasicMaterial({ color: 0x00d1c1 }));
    ring.visible = false;
    ring.raycast = () => {};
    orb.add(label, ring);
    orb.userData.outline = ring;
    orb.position.set(c.x, c.y, this.front + 0.03);
    const entity = this.world.createTransformEntity(orb, this.focus.boardEntity);
    entity.addComponent(ChildTask, { childId: c.id });
    entity.addComponent(RayInteractable);
    entity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
    return entity;
  }

  find(type, id) {
    if (!this.ws) return null;
    return (type === 'sticky' ? this.ws.stickies : this.ws.childTasks).find((x) => x.id === id) || null;
  }

  // Sub-tasks hang from the parent orb; linked stickies are joined to each other.
  updateLines() {
    if (!this.ws) return;
    const arr = this.lineGeo.attributes.position.array;
    let n = 0;
    const push = (a, b) => {
      if (n >= MAX_LINES) return;
      arr.set([a.x, a.y, a.z, b.x, b.y, b.z], n * 6);
      n++;
    };
    const anchor = this.focus.anchorLocal;
    for (const c of this.ws.childTasks) {
      const e = this.entities.get(`child:${c.id}`);
      if (e && e.object3D) push(anchor, e.object3D.position);
    }
    for (const link of this.ws.connections) {
      const a = this.entities.get(`sticky:${link.from}`);
      const b = this.entities.get(`sticky:${link.to}`);
      if (a && b && a.object3D && b.object3D) push(a.object3D.position, b.object3D.position);
    }
    this.lineGeo.setDrawRange(0, n * 2);
    this.lineGeo.attributes.position.needsUpdate = true;
  }

  /* ---------- selection and taps ---------- */

  select(sel, { silent = false } = {}) {
    this.selected = sel;
    this.entities.forEach((entity, key) => {
      const o = entity.object3D;
      if (o && o.userData.outline) o.userData.outline.visible = !!sel && key === `${sel.type}:${sel.id}`;
    });
    if (!sel) {
      this.sys.setPanel(this.actionsEntity, this.actions, false);
      if (this.mode) this.setMode(null);
      return;
    }
    const isSticky = sel.type === 'sticky';
    const item = this.find(sel.type, sel.id);
    const show = (id, on) => this.actions.requireElementById(id).setProperties({ display: on ? 'flex' : 'none' });
    show('act-done', !isSticky);
    show('act-colour', isSticky);
    show('act-link', isSticky);
    show('act-task', isSticky);
    this.actionDoneLabel.setProperties({ text: item && item.completed ? 'Not done' : 'Done' });
    this.actionDeleteLabel.setProperties({ text: isSticky ? 'Delete' : 'Remove' });
    this.sys.setPanel(this.actionsEntity, this.actions, !this.editor);
    if (!silent) Sound.play('select', { pos: this.focus.boardPos });
  }

  // A short pinch or click (no drag). Both the press and the grab can report one tap.
  onTap(type, id) {
    const key = `${type}:${id}`;
    const now = performance.now();
    if (this.lastTap.key === key && now - this.lastTap.at < 400) return;
    this.lastTap = { key, at: now };
    if (this.editor) return;
    const sel = this.selected;
    if (this.mode === 'link' && sel && sel.type === 'sticky' && type === 'sticky' && id !== sel.id) {
      this.toggleLink(sel.id, id);
      return;
    }
    if (this.mode === 'move') this.setMode(null);
    if (sel && sel.type === type && sel.id === id) this.select(null);
    else this.select({ type, id });
  }

  onPressStart(entity) {
    const o = entity.object3D;
    o.userData.pressFrom = o.getWorldPosition(o.userData.pressFrom || new Vector3());
  }

  onPressEnd(type, id, entity) {
    const o = entity.object3D;
    if (!o || !o.userData.pressFrom) return;
    if (o.getWorldPosition(this.v).distanceTo(o.userData.pressFrom) < TAP_MOVE) this.onTap(type, id);
  }

  onGrabStart(entity) {
    const o = entity.object3D;
    o.userData.grabFrom = o.getWorldPosition(o.userData.grabFrom || new Vector3());
  }

  // Released after a drag: settle onto the glass inside the canvas and save the spot.
  onGrabEnd(type, id, entity) {
    const o = entity.object3D;
    if (!o || !this.ws) return;
    const moved = o.userData.grabFrom ? o.getWorldPosition(this.v).distanceTo(o.userData.grabFrom) : 1;
    if (moved < TAP_MOVE) {
      this.placeLocal(o, type, this.find(type, id));
      this.onTap(type, id);
      return;
    }
    o.getWorldPosition(this.v);
    this.focus.board.worldToLocal(this.v);
    this.moveTo(type, id, this.v.x, this.v.y);
  }

  placeLocal(o, type, item) {
    if (!item) return;
    o.position.set(item.x, item.y, this.front + (type === 'sticky' ? 0.003 : 0.03));
  }

  moveTo(type, id, x, y) {
    const cx = MathUtils.clamp(x, BOUNDS.minX, BOUNDS.maxX);
    const cy = MathUtils.clamp(y, BOUNDS.minY, BOUNDS.maxY);
    this.change((w) => {
      const list = type === 'sticky' ? w.stickies : w.childTasks;
      const item = list.find((it) => it.id === id);
      if (item) { item.x = cx; item.y = cy; item.updatedAt = Date.now(); }
    });
    Sound.play('place', { pos: this.focus.boardPos });
  }

  // "Move", then tap a spot on the canvas (works with any pointer, including a mouse).
  onCanvasClick(event) {
    if (this.editor) return;
    if (this.mode === 'move' && this.selected && event && event.point) {
      this.v.copy(event.point);
      this.focus.board.worldToLocal(this.v);
      const { type, id } = this.selected;
      this.setMode(null);
      this.moveTo(type, id, this.v.x, this.v.y);
      return;
    }
    if (this.selected && !this.mode) this.select(null);
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'link') this.focus.setStatus('Tap another sticky to link it (tap a linked one to unlink).');
    else if (mode === 'move') this.focus.setStatus('Tap a spot on the canvas to move it there.');
    else this.focus.showSaved(this.ws && this.ws.updatedAt);
    this.actionLinkLabel.setProperties({ text: mode === 'link' ? 'Cancel link' : 'Link' });
  }

  /* ---------- actions ---------- */

  wireActions() {
    const a = this.actions;
    this.actionDoneLabel = a.requireElementById('act-done-label');
    this.actionDeleteLabel = a.requireElementById('act-delete-label');
    this.actionLinkLabel = a.requireElementById('act-link-label');
    const on = (id, fn) => this.sys.on(a, id, () => { if (this.selected) fn(this.selected); });
    on('act-edit', (sel) => this.openEditor(sel.type === 'sticky' ? 'edit-sticky' : 'edit-child', sel.id));
    on('act-colour', (sel) => {
      this.change((w) => {
        const s = w.stickies.find((x) => x.id === sel.id);
        if (s) s.color = COLOUR_ORDER[(COLOUR_ORDER.indexOf(s.color) + 1) % COLOUR_ORDER.length];
      });
    });
    on('act-link', () => this.setMode(this.mode === 'link' ? null : 'link'));
    on('act-move', () => this.setMode(this.mode === 'move' ? null : 'move'));
    on('act-task', (sel) => this.stickyToTask(sel.id));
    on('act-done', (sel) => this.toggleDone(sel.id));
    on('act-delete', (sel) => this.remove(sel.type, sel.id));
  }

  toggleLink(a, b) {
    let linked = false;
    this.change((w) => {
      const i = w.connections.findIndex((c) => (c.from === a && c.to === b) || (c.from === b && c.to === a));
      if (i >= 0) w.connections.splice(i, 1);
      else { w.connections.push({ id: uid('link'), from: a, to: b, createdAt: Date.now() }); linked = true; }
    });
    this.setMode(null);
    this.focus.setStatus(linked ? 'Linked. Linked notes form a group.' : 'Unlinked.');
    Sound.play('select', { pos: this.focus.boardPos });
  }

  toggleDone(id) {
    let nowDone = false;
    this.change((w) => {
      const c = w.childTasks.find((x) => x.id === id);
      if (!c) return;
      c.completed = !c.completed;
      c.completedAt = c.completed ? Date.now() : null;
      nowDone = c.completed;
    });
    if (nowDone) Sound.play('complete', { pos: this.focus.boardPos });
    this.select({ type: 'child', id }, { silent: true });
  }

  // Delete keeps an Undo for a few seconds instead of asking to confirm.
  remove(type, id) {
    const before = JSON.parse(JSON.stringify(this.ws));
    const item = this.find(type, id);
    if (!item) return;
    this.select(null);
    this.change((w) => {
      if (type === 'sticky') {
        w.stickies = w.stickies.filter((s) => s.id !== id);
        w.connections = w.connections.filter((c) => c.from !== id && c.to !== id);
      } else {
        w.childTasks = w.childTasks.filter((c) => c.id !== id);
      }
    });
    Sound.play('delete', { pos: this.focus.boardPos });
    this.offerUndo(type === 'sticky' ? 'Sticky deleted.' : 'Sub-task removed.', before);
  }

  stickyToTask(id) {
    const before = JSON.parse(JSON.stringify(this.ws));
    const s = this.find('sticky', id);
    if (!s) return;
    const childId = uid('task');
    this.select(null);
    this.change((w) => {
      w.stickies = w.stickies.filter((x) => x.id !== id);
      w.connections = w.connections.filter((c) => c.from !== id && c.to !== id);
      w.childTasks.push({ id: childId, title: s.text, completed: false, x: s.x, y: s.y, fromStickyId: id, createdAt: Date.now(), completedAt: null });
    });
    Sound.play('park', { pos: this.focus.boardPos });
    this.offerUndo('Sticky became a sub-task.', before);
  }

  offerUndo(message, before) {
    this.focus.showUndo(message, () => {
      this.change((w) => {
        w.stickies = before.stickies;
        w.childTasks = before.childTasks;
        w.connections = before.connections;
      });
      this.focus.setStatus('Restored.');
    });
  }

  /* ---------- adding ---------- */

  nextStickySpot() {
    const n = this.ws.stickies.length;
    const col = n % 3, row = Math.floor(n / 3) % 2, layer = Math.floor(n / 6);
    return { x: -0.4 + col * 0.205 + layer * 0.02, y: 0.12 - row * 0.135 - layer * 0.02 };
  }

  nextChildSpot() {
    const n = this.ws.childTasks.length;
    const col = n % 2, row = Math.floor(n / 2) % 3, layer = Math.floor(n / 6);
    return { x: -0.48 + col * 0.29 + layer * 0.02, y: -0.1 - row * 0.062 - layer * 0.015 };
  }

  addSticky(text) {
    const id = uid('note');
    const spot = this.nextStickySpot();
    const color = COLOUR_ORDER[this.ws.stickies.length % COLOUR_ORDER.length];
    this.change((w) => { w.stickies.push({ id, text, color, x: spot.x, y: spot.y, createdAt: Date.now(), updatedAt: Date.now() }); });
    Sound.play('park', { pos: this.focus.boardPos });
    return id;
  }

  addChild(title) {
    const id = uid('task');
    const spot = this.nextChildSpot();
    this.change((w) => { w.childTasks.push({ id, title, completed: false, x: spot.x, y: spot.y, createdAt: Date.now(), completedAt: null }); });
    Sound.play('park', { pos: this.focus.boardPos });
    return id;
  }

  /* ---------- editor ---------- */

  wireEditor() {
    const p = this.editorPanel;
    this.edHeading = p.requireElementById('editor-heading');
    this.edText = p.requireElementById('editor-text');
    this.edCount = p.requireElementById('editor-count');
    this.edHint = p.requireElementById('editor-hint');
    this.edSaveLabel = p.requireElementById('editor-save-label');
    this.edCancelLabel = p.requireElementById('editor-cancel-label');
    const keys = 'qwertyuiopasdfghjklzxcvbnm'.split('').map((k) => [k, k]);
    keys.push(['comma', ','], ['period', '.'], ['space', ' '], ['dash', '-'], ['question', '?']);
    for (const [id, ch] of keys) this.sys.on(p, `key-${id}`, () => this.type(ch));
    this.sys.on(p, 'key-back', () => this.backspace());
    this.sys.on(p, 'editor-save', () => this.saveEditor());
    this.sys.on(p, 'editor-cancel', () => this.closeEditor());

    // A physical keyboard (computer, or one paired with the headset) types too.
    const onKey = (e) => {
      if (!this.editor) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Enter') { e.preventDefault(); this.saveEditor(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.closeEditor(); }
      else if (e.key === 'Backspace') { e.preventDefault(); this.backspace(); }
      else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); this.type(e.key, true); }
    };
    window.addEventListener('keydown', onKey);
    this.sys.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));
  }

  openEditor(kind, id = null) {
    const item = id ? this.find(kind === 'edit-sticky' ? 'sticky' : 'child', id) : null;
    this.editor = { kind, id, text: item ? (item.text || item.title || '') : '', added: 0 };
    const headings = {
      'new-sticky': 'New sticky',
      'edit-sticky': 'Edit sticky',
      'new-child': 'Break down: add a smaller step',
      'edit-child': 'Edit sub-task',
    };
    this.edHeading.setProperties({ text: headings[kind] });
    this.edSaveLabel.setProperties({ text: kind === 'new-child' ? 'Add' : 'Save' });
    this.edCancelLabel.setProperties({ text: kind === 'new-child' ? 'Done' : 'Cancel' });
    this.edHint.setProperties({ text: kind === 'new-child' ? 'Add one step at a time. Tap Done when finished.' : 'Type with the keys below, or a keyboard.' });
    this.refreshEditor();
    this.sys.setPanel(this.actionsEntity, this.actions, false);
    this.sys.setPanel(this.editorEntity, this.editorPanel, true);
    if (this.mode) this.setMode(null);
  }

  closeEditor() {
    if (!this.editor) return;
    this.editor = null;
    this.sys.setPanel(this.editorEntity, this.editorPanel, false);
    if (this.selected) this.sys.setPanel(this.actionsEntity, this.actions, true);
  }

  refreshEditor() {
    const t = this.editor.text;
    this.edText.setProperties({ text: `${t}|` });
    this.edCount.setProperties({ text: `${t.length} / ${MAX_TEXT}` });
  }

  type(ch, exact = false) {
    if (!this.editor || this.editor.text.length >= MAX_TEXT) return;
    const t = this.editor.text;
    const startOfSentence = t.length === 0 || /[.?!]\s$/.test(t);
    if (ch === ' ' && (t.length === 0 || t.endsWith(' '))) return;
    this.editor.text += !exact && startOfSentence ? ch.toUpperCase() : ch;
    this.refreshEditor();
  }

  backspace() {
    if (!this.editor) return;
    this.editor.text = this.editor.text.slice(0, -1);
    this.refreshEditor();
  }

  saveEditor() {
    const ed = this.editor;
    if (!ed) return;
    const text = ed.text.trim();
    if (!text) {
      this.edHint.setProperties({ text: 'Type something first.' });
      return;
    }
    if (ed.kind === 'new-sticky') {
      const id = this.addSticky(text);
      this.closeEditor();
      this.select({ type: 'sticky', id }, { silent: true });
    } else if (ed.kind === 'new-child') {
      this.addChild(text);
      ed.text = '';
      ed.added += 1;
      this.edHint.setProperties({ text: `Added ${ed.added}. Add another, or tap Done.` });
      this.refreshEditor();
    } else {
      const type = ed.kind === 'edit-sticky' ? 'sticky' : 'child';
      this.change((w) => {
        const list = type === 'sticky' ? w.stickies : w.childTasks;
        const item = list.find((x) => x.id === ed.id);
        if (!item) return;
        if (type === 'sticky') item.text = text; else item.title = text;
        item.updatedAt = Date.now();
      });
      this.closeEditor();
    }
  }

  /* ---------- per frame ---------- */

  // Keep the action strip under the selected item and the editor over the canvas.
  update() {
    if (!this.ws) return;
    this.updateLines();
    if (this.actions.visible && this.selected) {
      const e = this.entities.get(`${this.selected.type}:${this.selected.id}`);
      if (e && e.object3D) {
        const o = e.object3D.position;
        const below = this.selected.type === 'sticky' ? STICKY_H / 2 + 0.045 : 0.06;
        const x = MathUtils.clamp(this.selected.type === 'sticky' ? o.x : o.x + 0.1, -0.3, 0.3);
        this.focus.placeOnBoard(this.actions, x, o.y - below, this.front + 0.05);
      }
    }
    if (this.editorPanel.visible) this.focus.placeOnBoard(this.editorPanel, -0.12, -0.02, this.front + 0.09);
  }
}
