import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  GrabSystem,
  Grabbed,
  Group,
  LineBasicMaterial,
  LineLoop,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  Points,
  PointsMaterial,
  Quaternion,
  RayInteractable,
  DistanceGrabbable,
  Shape,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { Sound } from './sound.js';
import { Tasks } from './tasks.js';
import { WorkspaceItems } from './workspace-items.js';

/*
 * Focus Mode, phase 1: grab a thought orb, drop it in the glowing ring in front of Pip, and
 * a glass thinking board opens in front of you while Pip, the other orbs and the sky dim
 * and step back. "Back to Orbit" (or pulling the orb off the board) saves and returns.
 */

const BOARD_W = 1.2;
const BOARD_H = 0.74;
const BOARD_D = 0.022;               // glass thickness
const BOARD_FRONT = BOARD_D + 0.004; // front face incl. bevel
const BOARD_DISTANCE = 1.0;          // metres in front of the viewer
const ANCHOR = new Vector3(-BOARD_W / 2 + 0.044 + 0.055, BOARD_H / 2 - 0.034 - 0.055, BOARD_FRONT + 0.05);
const SNAP_R = 0.18;                 // drop radius around the ring centre (m)
const PULL_OUT_R = 0.3;              // pulling the anchored orb this far off the board exits
const ENTER_MS = 650;
const EXIT_MS = 550;
const LAVENDER = 0xc4b5fd;
const TEAL = 0x00d1c1;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

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

function edgeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 660;
  const g = c.getContext('2d');
  const pad = 60;
  g.shadowColor = 'rgba(183, 148, 246, 0.9)';
  g.shadowBlur = 40;
  g.strokeStyle = 'rgba(196, 181, 253, 0.55)';
  g.lineWidth = 6;
  g.beginPath();
  if (g.roundRect) g.roundRect(pad, pad, c.width - pad * 2, c.height - pad * 2, 44);
  else g.rect(pad, pad, c.width - pad * 2, c.height - pad * 2);
  g.stroke();
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export class FocusMode {
  constructor(sys) {
    this.sys = sys;
    this.world = sys.world;
    this.state = 'idle';            // idle | entering | focused | exiting
    this.t = 0;
    this.taskId = null;
    this.orb = null;                // the parent thought's orb entity
    this.grabbing = null;
    this.ready = false;
    this.collapsed = false;
    this.v = new Vector3();
    this.v2 = new Vector3();
    this.v3 = new Vector3();
    this.q = new Quaternion();
    this.targetPos = new Vector3();
    this.boardPos = new Vector3();
    this.boardQuat = new Quaternion();
    this.anchorWorld = new Vector3();
    this.orbFrom = new Vector3();
    this.pipFrom = new Vector3();
    this.pipAway = new Vector3();
    this.grabFrom = new Vector3();
    this.dimmed = [];               // { material, color, emissive }

    this.boardFront = BOARD_FRONT;
    this.anchorLocal = ANCHOR;
    this.undoTimer = null;
    this.undoFn = null;

    this.buildTarget();
    this.buildBoard();
    this.wireBoard();
    this.items = new WorkspaceItems(this);

    const onKey = (e) => {
      if (e.key === 'Escape' && this.state === 'focused' && !this.items.editorOpen) this.exit();
    };
    window.addEventListener('keydown', onKey);
    sys.cleanupFuncs.push(() => window.removeEventListener('keydown', onKey));
  }

  get active() {
    return this.state !== 'idle';
  }

  /* ---------- drop target ---------- */

  buildTarget() {
    const group = new Group();
    group.name = 'Focus Drop Target';
    this.ringMat = new MeshBasicMaterial({ color: LAVENDER, transparent: true, opacity: 0.5, depthWrite: false });
    const ring = new Mesh(new TorusGeometry(0.14, 0.007, 16, 96), this.ringMat);
    this.discMat = new MeshBasicMaterial({ map: this.sys.glowTex, color: 0x8b5cf6, transparent: true, opacity: 0.15, blending: AdditiveBlending, depthWrite: false });
    const disc = new Mesh(new CircleGeometry(0.135, 64), this.discMat);
    ring.raycast = () => {};
    disc.raycast = () => {};
    group.add(disc, ring);
    group.visible = false;
    this.world.createTransformEntity(group);
    this.target = group;
  }

  // The ring sits in front of Pip's chest, between Pip and the viewer, facing the viewer.
  placeTarget() {
    const sys = this.sys;
    const s = sys.pipScale;
    this.v.copy(sys.head).sub(sys.pipPos).setY(0);
    if (this.v.lengthSq() < 1e-6) this.v.set(0, 0, 1);
    this.v.normalize();
    this.targetPos.copy(sys.pipPos).addScaledVector(this.v, 0.42 * s);
    this.targetPos.y += (sys.ORBIT_Y + 0.08) * s;
    this.target.position.copy(this.targetPos);
    this.v2.set(sys.head.x, this.targetPos.y, sys.head.z);
    this.target.lookAt(this.v2);
    this.target.scale.setScalar(s);
  }

  onGrabStart(entity) {
    const sys = this.sys;
    if (this.state === 'focused' && entity === this.orb) {
      this.grabbing = entity;
      return;
    }
    if (this.active) return;
    sys.closeCard();
    this.grabbing = entity;
    this.ready = false;
    entity.object3D.getWorldPosition(this.grabFrom);
    entity.object3D.userData.held = true;
    entity.object3D.material.emissiveIntensity = 1.6;
    this.placeTarget();
    this.target.visible = true;
  }

  /** Returns true when the release was a drag (not a tap). */
  onGrabEnd(entity) {
    if (entity !== this.grabbing) return false;
    this.grabbing = null;
    const mesh = entity.object3D;
    mesh.getWorldPosition(this.v);

    if (this.state === 'focused' && entity === this.orb) {
      if (this.v.distanceTo(this.anchorWorld) > PULL_OUT_R) this.exit();
      return true;
    }
    this.target.visible = false;
    const moved = this.v.distanceTo(this.grabFrom);
    if (this.ready) {
      this.ready = false;
      this.enter(mesh.userData.taskId, entity);
      return true;
    }
    mesh.userData.held = false;
    mesh.material.emissiveIntensity = 0.9;
    if (moved >= 0.05) {
      mesh.userData.returning = 0; // PipSystem eases it back to its place in the orbit
      return true;
    }
    return false;
  }

  updateGrab() {
    const sys = this.sys;
    const mesh = this.grabbing.object3D;
    this.placeTarget();
    mesh.getWorldPosition(this.v);
    const d = this.v.distanceTo(this.targetPos);
    const s = sys.pipScale;
    const p = MathUtils.clamp(1 - (d - SNAP_R * s) / 0.5, 0, 1);
    const ready = d < SNAP_R * s;
    if (ready && !this.ready) Sound.play('ready', { pos: this.targetPos });
    this.ready = ready;
    this.ringMat.color.set(ready ? TEAL : LAVENDER);
    this.ringMat.opacity = 0.35 + 0.6 * p;
    this.discMat.opacity = ready ? 0.55 + 0.1 * Math.sin(performance.now() / 120) : 0.12 + 0.35 * p;
    this.target.scale.setScalar(s * (ready ? 1.12 : 1 + 0.05 * p));
    // A gentle pull toward the centre once inside the ring, so the drop feels like a snap.
    if (ready) {
      this.v.lerp(this.targetPos, 0.2);
      mesh.position.copy(mesh.parent.worldToLocal(this.v2.copy(this.v)));
    }
  }

  /* ---------- the glass board ---------- */

  buildBoard() {
    const group = new Group();
    group.name = 'Focus Workspace';
    const shape = roundedRect(BOARD_W, BOARD_H, 0.05);
    this.slabMat = new MeshPhysicalMaterial({
      color: 0x2b1f63, transparent: true, opacity: 0.3, roughness: 0.15, metalness: 0,
      clearcoat: 1, clearcoatRoughness: 0.1, emissive: 0x1a1145, emissiveIntensity: 0.6, depthWrite: false,
    });
    const slab = new Mesh(new ExtrudeGeometry(shape, { depth: BOARD_D, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 3, curveSegments: 12 }), this.slabMat);
    slab.name = 'Glass Slab';
    slab.raycast = () => {};

    this.edgeMat = new LineBasicMaterial({ color: LAVENDER, transparent: true, opacity: 0.85 });
    const edge = new LineLoop(new BufferGeometry().setFromPoints(shape.getPoints(24).map((p) => new Vector3(p.x, p.y, BOARD_FRONT + 0.001))), this.edgeMat);
    edge.raycast = () => {};

    this.glowMat = new MeshBasicMaterial({ map: edgeGlowTexture(), transparent: true, opacity: 0.7, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    const glow = new Mesh(new PlaneGeometry(BOARD_W * 1024 / 904, BOARD_H * 660 / 540), this.glowMat);
    glow.position.z = -0.002;
    glow.raycast = () => {};

    // A faint dot grid marks the thinking canvas (left of the context column).
    const dots = [];
    for (let x = -BOARD_W / 2 + 0.07; x < BOARD_W / 2 - 0.46; x += 0.06) {
      for (let y = -BOARD_H / 2 + 0.09; y < BOARD_H / 2 - 0.17; y += 0.06) dots.push(x, y, BOARD_FRONT + 0.001);
    }
    const dotGeo = new BufferGeometry();
    dotGeo.setAttribute('position', new Float32BufferAttribute(dots, 3));
    this.dotMat = new PointsMaterial({ color: LAVENDER, size: 0.005, transparent: true, opacity: 0.22, depthWrite: false });
    const grid = new Points(dotGeo, this.dotMat);
    grid.raycast = () => {};

    group.add(glow, slab, edge, grid);
    group.visible = false;
    this.boardEntity = this.world.createTransformEntity(group);
    this.board = group;

    this.panelEntity = this.world.requireSceneEntity('focus-board');
    this.panel = this.world.requireSceneObject('focus-board');
    this.sys.setPanel(this.panelEntity, this.panel, false);
  }

  wireBoard() {
    const p = this.panel;
    this.title = p.requireElementById('focus-title');
    this.ctxTitle = p.requireElementById('ctx-title');
    this.ctxContext = p.requireElementById('ctx-context');
    this.ctxNext = p.requireElementById('ctx-next');
    this.ctxProgress = p.requireElementById('ctx-progress');
    this.ctxBody = p.requireElementById('focus-context-body');
    this.toggleLabel = p.requireElementById('focus-context-toggle-label');
    this.saved = p.requireElementById('focus-saved');
    this.undoBtn = p.requireElementById('focus-undo');
    this.sys.on(p, 'focus-back', () => this.exit());
    this.sys.on(p, 'focus-add-sticky', () => { if (this.state === 'focused') this.items.openEditor('new-sticky'); });
    this.sys.on(p, 'focus-breakdown', () => { if (this.state === 'focused') this.items.openEditor('new-child'); });
    this.sys.on(p, 'focus-undo', () => {
      const fn = this.undoFn;
      this.hideUndo();
      if (fn) fn();
    });
    this.sys.on(p, 'focus-canvas', (e) => { if (this.state === 'focused') this.items.onCanvasClick(e); });
    this.sys.on(p, 'focus-context-toggle', () => {
      this.collapsed = !this.collapsed;
      this.applyCollapsed();
      this.showSaved(Tasks.updateWorkspace(this.taskId, (w) => { w.layout.contextCollapsed = this.collapsed; }));
    });
  }

  applyCollapsed() {
    this.ctxBody.setProperties({ display: this.collapsed ? 'none' : 'flex' });
    this.toggleLabel.setProperties({ text: this.collapsed ? 'Show' : 'Hide' });
  }

  setStatus(text) {
    this.saved.setProperties({ text });
  }

  // A short-lived Undo for deletes and conversions (instead of a confirmation prompt).
  showUndo(message, fn) {
    this.undoFn = fn;
    this.setStatus(message);
    this.undoBtn.setProperties({ display: 'flex' });
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.hideUndo(), 8000);
  }

  hideUndo() {
    clearTimeout(this.undoTimer);
    this.undoFn = null;
    if (this.undoBtn) this.undoBtn.setProperties({ display: 'none' });
  }

  refreshProgress() {
    if (!this.taskId) return;
    const { done, total } = Tasks.childProgress(this.taskId);
    this.ctxProgress.setProperties({ text: total ? `${done} of ${total} done` : 'None yet' });
    if (this.orb && this.orb.object3D) this.sys.applyProgress(this.orb.object3D, this.taskId);
  }

  // Put a panel on the board at board-local (x, y, z), facing the same way as the glass.
  placeOnBoard(panel, x, y, z) {
    this.v.set(x, y, z);
    this.board.localToWorld(this.v);
    panel.position.copy(panel.parent.worldToLocal(this.v));
    panel.quaternion.copy(this.boardQuat);
    panel.scale.setScalar(0.1);
  }

  showSaved(at) {
    if (!at) {
      this.saved.setProperties({ text: 'Not saved: this browser blocked storage' });
      return;
    }
    const time = new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.saved.setProperties({ text: `Saved ${time}` });
  }

  fillBoard(task) {
    this.title.setProperties({ text: task.title });
    this.ctxTitle.setProperties({ text: task.title });
    this.ctxContext.setProperties({ text: task.context || 'Not added yet' });
    this.ctxNext.setProperties({ text: task.nextStep || 'Not added yet' });
    const { done, total } = Tasks.childProgress(task.id);
    this.ctxProgress.setProperties({ text: total ? `${done} of ${total} done` : 'None yet' });
  }

  // Board stands 1 m in front of the viewer at about chest-to-eye height, facing them, and
  // stays put (it does not follow the head).
  placeBoard() {
    const sys = this.sys;
    this.v.copy(sys.headDir).setY(0);
    if (this.v.lengthSq() < 1e-4) this.v.set(0, 0, -1);
    this.v.normalize();
    this.boardPos.copy(sys.head).addScaledVector(this.v, BOARD_DISTANCE);
    this.boardPos.y = sys.head.y - 0.12;
    this.board.position.copy(this.boardPos);
    this.v2.set(sys.head.x, this.boardPos.y, sys.head.z);
    this.board.lookAt(this.v2);
    this.boardQuat.copy(this.board.quaternion);
    this.board.updateMatrixWorld(true);
    this.anchorWorld.copy(ANCHOR).applyMatrix4(this.board.matrixWorld);
  }

  // Keep the text layer on the glass's front face, following the board's open animation.
  syncPanel(scale) {
    this.v.set(0, 0, BOARD_FRONT + 0.003).applyQuaternion(this.boardQuat).add(this.boardPos);
    this.panel.position.copy(this.panel.parent.worldToLocal(this.v));
    this.panel.quaternion.copy(this.boardQuat);
    this.panel.scale.setScalar(0.1 * scale);
  }

  /* ---------- dimming the orbit ---------- */

  collectDimmable() {
    this.dimmed.length = 0;
    const roots = [this.world.requireSceneObject('pip-model'), this.sys.pipModelHolder].filter(Boolean);
    for (const root of roots) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m && m.color) this.dimmed.push({ material: m, color: m.color.clone(), emissive: m.emissive ? m.emissive.clone() : null });
        }
      });
    }
  }

  setDim(e) {
    const sys = this.sys;
    sys.cosmos.setDim(MathUtils.lerp(1, 0.32, e));
    const f = MathUtils.lerp(1, 0.3, e);
    for (const d of this.dimmed) {
      d.material.color.copy(d.color).multiplyScalar(f);
      if (d.emissive) d.material.emissive.copy(d.emissive).multiplyScalar(f);
    }
    for (const entity of sys.queries.orbs.entities) {
      if (entity === this.orb) continue;
      const mesh = entity.object3D;
      mesh.material.opacity = MathUtils.lerp(1, 0.12, e);
      mesh.userData.glow.material.opacity = MathUtils.lerp(1, 0.08, e);
      for (const m of mesh.userData.markMats || []) m.opacity = MathUtils.lerp(m.userData.baseOpacity, 0.05, e);
    }
    this.sys.orbitPathMat.opacity = MathUtils.lerp(0.5, 0.06, e);
    this.slabMat.opacity = 0.3 * e;
    this.edgeMat.opacity = 0.85 * e;
    this.glowMat.opacity = 0.7 * e;
    this.dotMat.opacity = 0.22 * e;
  }

  /* ---------- enter / exit ---------- */

  enter(taskId, entity) {
    const sys = this.sys;
    const task = Tasks.get(taskId);
    if (!task || !entity || this.active) return;
    try { this.world.getSystem(GrabSystem)?.forceRelease(entity); } catch (e) { /* not held */ }
    this.taskId = taskId;
    this.orb = entity;
    sys.closeCard();
    sys.setPanel(sys.bubbleEntity, sys.bubble, false);
    sys.setPanel(sys.hudEntity, sys.hud, false);
    this.target.visible = false;

    // Only the parent orb stays interactive while focused.
    for (const other of sys.queries.orbs.entities) {
      if (other === entity) continue;
      if (other.hasComponent(DistanceGrabbable)) other.removeComponent(DistanceGrabbable);
      if (other.hasComponent(RayInteractable)) other.removeComponent(RayInteractable);
    }

    const mesh = entity.object3D;
    mesh.userData.held = true;
    mesh.getWorldPosition(this.orbFrom);
    this.pipFrom.copy(sys.pipRoot.position);
    this.v.copy(sys.pipPos).sub(sys.head).setY(0);
    if (this.v.lengthSq() < 1e-6) this.v.set(0, 0, -1);
    // Pip steps back and to the side, so it stays in view without sitting behind the board.
    this.v.normalize();
    this.v2.set(-this.v.z, 0, this.v.x); // viewer's right
    this.pipAway.copy(this.pipFrom).addScaledVector(this.v, 1.1).addScaledVector(this.v2, 0.95);
    this.placeBoard();
    this.collectDimmable();

    const w = Tasks.workspace(taskId);
    this.collapsed = !!w.layout.contextCollapsed;
    this.applyCollapsed();
    this.fillBoard(task);
    this.showSaved(Tasks.updateWorkspace(taskId, (ws) => { ws.openCount += 1; ws.lastOpenedAt = Date.now(); }));

    this.hideUndo();
    this.items.open(taskId);
    this.board.visible = true;
    document.body.classList.add('focusing'); // the page's capture panel steps aside (3D preview)
    this.state = 'entering';
    this.t = 0;
    Sound.play('focusIn', { pos: this.boardPos });
  }

  exit() {
    if (this.state !== 'focused') return;
    this.showSaved(Tasks.updateWorkspace(this.taskId, (w) => { w.layout.contextCollapsed = this.collapsed; }));
    this.sys.setPanel(this.panelEntity, this.panel, false);
    this.items.closeEditor();
    this.items.select(null);
    this.hideUndo();
    this.orb.object3D.getWorldPosition(this.orbFrom);
    this.state = 'exiting';
    this.t = 0;
    Sound.play('focusOut', { pos: this.boardPos });
  }

  /** Leaving XR mid-focus: save and restore the orbit at once. */
  forceExit() {
    if (!this.active) return;
    if (this.taskId) Tasks.updateWorkspace(this.taskId, (w) => { w.layout.contextCollapsed = this.collapsed; });
    this.finishExit();
  }

  finishExit() {
    const sys = this.sys;
    this.setDim(0);
    sys.pipRoot.position.copy(this.pipFrom);
    this.items.close();
    this.board.visible = false;
    sys.setPanel(this.panelEntity, this.panel, false);
    if (this.orb) this.orb.object3D.userData.held = false;
    document.body.classList.remove('focusing');
    this.state = 'idle';
    this.orb = null;
    this.taskId = null;
    sys.afterFocus();
  }

  /* ---------- per frame ---------- */

  update(delta) {
    const sys = this.sys;
    if (this.grabbing && this.state === 'idle') this.updateGrab();
    if (this.state === 'idle') return;

    const mesh = this.orb.object3D;
    if (this.state === 'entering' || this.state === 'exiting') {
      this.t = Math.min(1, this.t + (delta * 1000) / (this.state === 'entering' ? ENTER_MS : EXIT_MS));
      const e = this.state === 'entering' ? ease(this.t) : 1 - ease(this.t);
      const open = MathUtils.lerp(0.04, 1, e);
      this.board.scale.set(open, open, 1);
      this.setDim(e);
      sys.pipRoot.position.lerpVectors(this.pipFrom, this.pipAway, e);
      if (this.state === 'entering') {
        this.v.lerpVectors(this.orbFrom, this.anchorWorld, ease(this.t));
      } else {
        // Fly back to its place in the orbit (which is also moving back toward the viewer).
        sys.orbit.updateMatrixWorld(true);
        this.v2.copy(mesh.userData.basePos).applyMatrix4(sys.orbit.matrixWorld);
        this.v.lerpVectors(this.orbFrom, this.v2, ease(this.t));
      }
      mesh.position.copy(mesh.parent.worldToLocal(this.v3.copy(this.v)));
      mesh.scale.setScalar(MathUtils.lerp(1, 0.8 / sys.pipScale, e));
      if (this.t >= 1) {
        if (this.state === 'entering') {
          this.state = 'focused';
          this.syncPanel(1);
          sys.setPanel(this.panelEntity, this.panel, true);
        } else {
          this.finishExit();
        }
      }
      return;
    }

    // Focused: the parent orb rests on the board's corner unless it is being pulled.
    if (!this.orb.hasComponent(Grabbed)) {
      mesh.position.copy(mesh.parent.worldToLocal(this.v.copy(this.anchorWorld)));
      mesh.scale.setScalar(0.8 / sys.pipScale);
    }
    mesh.material.emissiveIntensity = 1.2 + 0.25 * Math.sin(performance.now() / 700);
    this.syncPanel(1);
    this.items.update();
  }
}
