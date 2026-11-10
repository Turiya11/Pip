import {
  AdditiveBlending,
  AssetManager,
  Box3,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  createSystem,
  DistanceGrabbable,
  DoubleSide,
  EnvironmentRaycastTarget,
  Grabbed,
  Group,
  Hovered,
  LineDashedMaterial,
  LineLoop,
  MathUtils,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MovementMode,
  Object3D,
  Pressed,
  Quaternion,
  RayInteractable,
  RaycastSpace,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { createCosmos } from './cosmos.js';
import { FocusMode } from './focus-mode.js';
import { ChildTask, Orb, Sticky } from './pip-components.js';
import { Sound } from './sound.js';
import { Tasks } from './tasks.js';

// Sizes are relative to Pip's height (0.8 m) and everything is parented to Pip, so a resize
// keeps the orbs, card and controls in proportion. Orb diameter is 1/6 of Pip's height.
const PIP_HEIGHT = 0.8;
const ORB_R = PIP_HEIGHT / 6 / 2;
const ORBIT_R = 0.55;
const ORBIT_Y = 0.6;
const ORBS_PER_GROUP = 3;
const PIP_HALF_W = 0.22;
const CARD_HALF_W = 0.22;
const PREVIEW_POSITION = new Vector3(0, 0.85, -1.2);

// Hand gestures (same thresholds as the HoloLens web build).
const PINCH_ON = 0.025;          // thumb–index gap that starts a pinch (m)
const PINCH_OFF = 0.045;         // gap that ends it (hysteresis)
const PALM_HOLD_MS = 1000;       // open palm held still this long places Pip
const PALM_STILL_M = 0.12;       // how far the hand may move while holding
const FINGERS = ['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const FINGER_JOINTS = ['phalanx-proximal', 'phalanx-intermediate', 'phalanx-distal', 'tip'];

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

export class PipSystem extends createSystem({
  orbs: { required: [Orb] },
  pressedOrbs: { required: [Orb, Pressed] },
  grabbedOrbs: { required: [Orb, Grabbed] },
  pressedStickies: { required: [Sticky, Pressed] },
  grabbedStickies: { required: [Sticky, Grabbed] },
  pressedChildren: { required: [ChildTask, Pressed] },
  grabbedChildren: { required: [ChildTask, Grabbed] },
  hovered: { required: [Hovered] },
  probes: { required: [EnvironmentRaycastTarget] },
}) {
  init() {
    this.inXR = false;
    this.selectedId = null;
    this.ORBIT_Y = ORBIT_Y;
    this.lastTap = { id: null, at: 0 };
    this.groupIndex = 0;
    this.pipScale = 1;
    this.pendingAutoPlace = false;
    this.pipAppeared = false;
    this.xrFrames = 0;

    this.tmp = new Vector3();
    this.tmp2 = new Vector3();
    this.head = new Vector3();
    this.headDir = new Vector3();
    this.headUp = new Vector3();
    this.headQuat = new Quaternion();
    this.pipPos = new Vector3();
    this.up = new Vector3(0, 1, 0);
    this.rayOrigin = new Vector3();
    this.rayDir = new Vector3();
    this.rayQuat = new Quaternion();
    this.surfacePoint = new Vector3();
    this.thumb = new Vector3();
    this.index = new Vector3();
    this.fingerPts = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    this.palmNormal = new Vector3();
    this.handStates = new WeakMap();
    this.handZoom = null;

    // Pip and its panels come from the authored scene.
    this.pipEntity = this.world.requireSceneEntity('pip-root');
    this.pipRoot = this.pipEntity.object3D;
    this.cardEntity = this.world.requireSceneEntity('task-card');
    this.card = this.world.requireSceneObject('task-card');
    this.hudEntity = this.world.requireSceneEntity('pip-hud');
    this.hud = this.world.requireSceneObject('pip-hud');
    this.bubbleEntity = this.world.requireSceneEntity('welcome-bubble');
    this.bubble = this.world.requireSceneObject('welcome-bubble');
    this.setPanel(this.cardEntity, this.card, false);
    this.setPanel(this.hudEntity, this.hud, false);
    this.setPanel(this.bubbleEntity, this.bubble, false);
    this.wirePanels();

    // Calm deep-space surroundings (opaque, so in passthrough they cover the room).
    this.cosmos = createCosmos();
    this.world.createTransformEntity(this.cosmos.group);

    // Orbit: a dashed ring with the thoughts' orbs, centred on Pip's chest. The orbs stay in
    // place (no circling) so a thought is always where you last saw it.
    const orbit = new Group();
    orbit.name = 'Orbit';
    orbit.position.set(0, ORBIT_Y, 0);
    const pts = Array.from({ length: 128 }, (_, i) => {
      const a = (i / 128) * Math.PI * 2;
      return new Vector3(Math.cos(a) * ORBIT_R, 0, Math.sin(a) * ORBIT_R);
    });
    this.orbitPathMat = new LineDashedMaterial({ color: 0xb794f6, transparent: true, opacity: 0.5, dashSize: 0.012, gapSize: 0.024 });
    const path = new LineLoop(new BufferGeometry().setFromPoints(pts), this.orbitPathMat);
    path.computeLineDistances();
    orbit.add(path);
    this.orbitEntity = this.world.createTransformEntity(orbit, this.pipEntity);
    this.orbit = orbit;
    this.orbGeo = new SphereGeometry(ORB_R, 48, 48);
    this.markGeo = new TorusGeometry(ORB_R * 1.4, 0.0025, 8, 64);
    this.glowTex = glowTexture();
    this.focus = new FocusMode(this);
    this.rebuildOrbit();
    this.cleanupFuncs.push(Tasks.onChange(() => {
      if (this.focus.active) this.rebuildPending = true; // rebuilt when Focus Mode closes
      else this.rebuildOrbit();
    }));

    // A short pinch/click on an orb (no drag) opens its card; a drag into the ring opens Focus
    // Mode. Both paths can report the same tap, so it is handled once.
    this.queries.pressedOrbs.subscribe('qualify', (entity) => {
      const mesh = entity.object3D;
      mesh.userData.pressFrom = mesh.getWorldPosition(mesh.userData.pressFrom || new Vector3());
    });
    this.queries.pressedOrbs.subscribe('disqualify', (entity) => {
      const mesh = entity.object3D;
      if (!mesh || this.focus.active || !mesh.userData.pressFrom) return;
      if (mesh.getWorldPosition(this.tmp).distanceTo(mesh.userData.pressFrom) < 0.05) this.onOrbTap(entity.getValue(Orb, 'taskId'));
    });
    // Stickies and sub-tasks on the Focus board: tap selects, drag moves.
    const items = this.focus.items;
    for (const [type, comp, field, pressed, grabbed] of [
      ['sticky', Sticky, 'noteId', this.queries.pressedStickies, this.queries.grabbedStickies],
      ['child', ChildTask, 'childId', this.queries.pressedChildren, this.queries.grabbedChildren],
    ]) {
      pressed.subscribe('qualify', (e) => e.object3D && items.onPressStart(e));
      pressed.subscribe('disqualify', (e) => {
        const id = e.getValue(comp, field);
        this.later(() => e.object3D && items.onPressEnd(type, id, e));
      });
      grabbed.subscribe('qualify', (e) => e.object3D && items.onGrabStart(e));
      grabbed.subscribe('disqualify', (e) => {
        const id = e.getValue(comp, field);
        this.later(() => e.object3D && items.onGrabEnd(type, id, e));
      });
    }
    this.queries.grabbedOrbs.subscribe('qualify', (entity) => this.focus.onGrabStart(entity));
    this.queries.grabbedOrbs.subscribe('disqualify', (entity) => {
      if (!entity.object3D) return;
      const dragged = this.focus.onGrabEnd(entity);
      if (!dragged && !this.focus.active) this.onOrbTap(entity.getValue(Orb, 'taskId'));
    });

    // Ring that shows where Pip will stand; it fills while an open palm is held still.
    const ring = new Mesh(new RingGeometry(0.12, 0.15, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0x00d1c1, side: DoubleSide, transparent: true, opacity: 0.9 }));
    ring.name = 'Placement Ring';
    this.ringFill = new Mesh(new CircleGeometry(0.11, 48).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({ color: 0x00d1c1, side: DoubleSide, transparent: true, opacity: 0.45 }));
    this.ringFill.visible = false;
    ring.add(this.ringFill);
    ring.visible = false;
    this.ringEntity = this.world.createTransformEntity(ring);
    this.ring = ring;

    // Real-surface hits along each hand/controller ray (IWSDK environment raycast).
    this.probes = {};
    for (const [side, space] of [['left', RaycastSpace.Left], ['right', RaycastSpace.Right]]) {
      const probe = this.world.createTransformEntity(new Object3D());
      probe.object3D.name = `Surface Probe ${side}`;
      probe.addComponent(EnvironmentRaycastTarget, { space, maxDistance: 6 });
      this.probes[side] = probe;
    }

    // Swap the procedural Pip for the astronaut model when it loads; keep it otherwise.
    AssetManager.loadGLTFById('pip-astronaut').then((gltf) => {
      const model = gltf.scene;
      model.name = 'Pip Astronaut';
      const box = new Box3().setFromObject(model);
      const size = box.getSize(new Vector3());
      if (size.y > 0) model.scale.multiplyScalar(PIP_HEIGHT / size.y);
      box.setFromObject(model);
      const center = box.getCenter(new Vector3());
      model.position.set(-center.x, -box.min.y, -center.z);
      const holder = new Group();
      holder.add(model);
      this.world.createTransformEntity(holder, this.pipEntity);
      this.pipModelHolder = holder;
      this.world.requireSceneObject('pip-model').visible = false;
    }).catch(() => { /* procedural Pip stays */ });

    this.cleanupFuncs.push(this.visibilityState.subscribe((state) => {
      const inXR = state !== VisibilityState.NonImmersive;
      if (inXR === this.inXR) return;
      this.inXR = inXR;
      this.focus.forceExit();
      this.closeCard();
      if (inXR) {
        this.pendingAutoPlace = true;
        this.xrFrames = 0;
        this.setPanel(this.hudEntity, this.hud, true);
      } else {
        this.setPanel(this.hudEntity, this.hud, false);
        this.setPanel(this.bubbleEntity, this.bubble, false);
        this.ring.visible = false;
        this.pipRoot.position.copy(PREVIEW_POSITION);
        this.pipRoot.rotation.set(0, 0, 0);
        this.setScale(1);
      }
    }));
  }

  /* ---------- panels ---------- */

  // Hidden panels also drop RayInteractable so an invisible card can't catch a pinch.
  // The wanted state is re-applied every frame, because loading the level can re-apply
  // the authored visibility and components after init.
  setPanel(entity, object, visible) {
    if (!this.panelWant) this.panelWant = new Map();
    this.panelWant.set(entity, { object, visible });
    this.applyPanel(entity, object, visible);
  }

  applyPanel(entity, object, visible) {
    if (object.visible !== visible) object.visible = visible;
    const has = entity.hasComponent(RayInteractable);
    if (visible && !has) entity.addComponent(RayInteractable);
    if (!visible && has) entity.removeComponent(RayInteractable);
  }

  // UI clicks run at the start of the next frame, never inside the pointer library's own event
  // dispatch, because a click may hide its panel or rebuild the objects it was sent to.
  on(panel, id, fn) {
    const el = panel.requireElementById(id);
    el.name = id;
    const handler = (e) => {
      const point = e && e.point ? e.point.clone() : null;
      this.later(() => fn({ point }));
    };
    el.addEventListener('click', handler);
    this.cleanupFuncs.push(() => el.removeEventListener('click', handler));
    return el;
  }

  later(fn) {
    (this.deferred || (this.deferred = [])).push(fn);
  }

  runDeferred() {
    if (!this.deferred || !this.deferred.length) return;
    const jobs = this.deferred.splice(0);
    for (const job of jobs) {
      try { job(); } catch (err) { console.error('[pip]', err); }
    }
  }

  wirePanels() {
    this.cardTitle = this.card.requireElementById('card-title');
    this.cardContext = this.card.requireElementById('card-context');
    this.cardNext = this.card.requireElementById('card-next');
    this.on(this.card, 'card-close', () => this.closeCard());
    this.on(this.card, 'card-done', () => {
      if (!this.selectedId) return;
      const pos = this.selectedOrbWorld(this.tmp2) || this.pipWorld(this.tmp2);
      Sound.play('complete', { pos });
      const id = this.selectedId;
      this.closeCard();
      Tasks.complete(id); // rebuilds the orbit through Tasks.onChange
    });
    // Same as dropping the orb in the ring, for when grabbing isn't practical (mouse, gaze).
    this.on(this.card, 'card-focus', () => {
      const id = this.selectedId;
      const entity = this.orbEntity(id);
      if (entity) this.focus.enter(id, entity);
    });

    this.on(this.hud, 'hud-exit', () => this.world.exitXR());
    this.hudNext = this.on(this.hud, 'hud-next', () => {
      this.groupIndex = (this.groupIndex + 1) % this.groupCount();
      this.closeCard();
      this.rebuildOrbit();
      Sound.play('select', { pos: this.pipWorld(this.tmp2) });
    });
    this.on(this.hud, 'hud-smaller', () => this.setScale(this.pipScale * 0.85));
    this.on(this.hud, 'hud-bigger', () => this.setScale(this.pipScale * 1.15));

    this.bubbleCopy = this.bubble.requireElementById('bubble-copy');
    this.bubbleShow = this.bubble.requireElementById('bubble-show');
    this.bubbleLaterLabel = this.bubble.requireElementById('bubble-later-label');
    this.on(this.bubble, 'bubble-later', () => this.setPanel(this.bubbleEntity, this.bubble, false));
    this.on(this.bubble, 'bubble-show', () => {
      this.setPanel(this.bubbleEntity, this.bubble, false);
      const first = Tasks.orbit()[0]; // due reminders first
      if (!first) return;
      this.groupIndex = 0;
      this.rebuildOrbit();
      this.openCard(first.id);
    });
  }

  showWelcome() {
    const n = Tasks.orbit().length;
    this.bubbleCopy.setProperties({ text: n ? `${n} ${n === 1 ? 'thought is' : 'thoughts are'} orbiting me.` : 'Nothing is orbiting me yet.' });
    this.bubbleShow.setProperties({ display: n ? 'flex' : 'none' });
    this.bubbleLaterLabel.setProperties({ text: n ? 'Not yet' : 'Got it' });
    this.setPanel(this.bubbleEntity, this.bubble, true);
    Sound.play('welcome', { pos: this.pipWorld(this.tmp2) });
  }

  /* ---------- orbit ---------- */

  groupCount() {
    return Math.max(1, Math.ceil(Tasks.orbit().length / ORBS_PER_GROUP));
  }

  currentGroup() {
    this.groupIndex = Math.min(this.groupIndex, this.groupCount() - 1);
    return Tasks.orbit().slice(this.groupIndex * ORBS_PER_GROUP, (this.groupIndex + 1) * ORBS_PER_GROUP);
  }

  rebuildOrbit() {
    for (const entity of [...this.queries.orbs.entities]) entity.dispose();
    const group = this.currentGroup();
    if (this.selectedId && !group.some((t) => t.id === this.selectedId)) this.closeCard();
    const step = (Math.PI * 2) / Math.max(group.length, 1);
    group.forEach((task, i) => {
      const due = Tasks.isDue(task);
      const sphere = new Mesh(this.orbGeo, new MeshStandardMaterial({
        color: due ? 0xfcd34d : 0xc084fc,
        emissive: due ? 0xd97706 : 0x7e22ce,
        emissiveIntensity: 0.9,
        roughness: 0.1,
        transparent: true,
        depthWrite: false,
      }));
      sphere.name = `Orb ${task.title}`;
      const glow = new Sprite(new SpriteMaterial({ map: this.glowTex, color: due ? 0xfbbf24 : 0xc084fc, transparent: true, blending: AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(0.42 * ORB_R / 0.08);
      glow.raycast = () => {};
      sphere.add(glow);
      sphere.userData.taskId = task.id;
      this.applyProgress(sphere, task.id);
      sphere.userData.basePos = new Vector3(Math.cos(i * step) * ORBIT_R, 0, Math.sin(i * step) * ORBIT_R);
      sphere.userData.phase = i * 1.7;
      sphere.userData.glow = glow;
      sphere.position.copy(sphere.userData.basePos);
      const entity = this.world.createTransformEntity(sphere, this.orbitEntity);
      entity.addComponent(Orb, { taskId: task.id });
      entity.addComponent(RayInteractable);
      // Ray grab (controller trigger or hand pinch): the orb follows the pointer at its distance.
      entity.addComponent(DistanceGrabbable, { movementMode: MovementMode.MoveFromTarget, rotate: false, scale: false, translate: true });
    });
    if (this.hudNext) this.hudNext.setProperties({ display: Tasks.orbit().length > ORBS_PER_GROUP ? 'flex' : 'none' });
    this.styleOrbs();
  }

  // A selected orb glows and grows a little; the others fade back.
  styleOrbs() {
    for (const entity of this.queries.orbs.entities) {
      const mesh = entity.object3D;
      const selected = entity.getValue(Orb, 'taskId') === this.selectedId;
      const dim = this.selectedId && !selected;
      mesh.material.emissiveIntensity = selected ? 1.8 : dim ? 0.25 : 0.9;
      mesh.material.opacity = dim ? 0.28 : 1;
      mesh.userData.glow.material.opacity = dim ? 0.3 : 1;
      mesh.userData.scale = selected ? 1.2 : dim ? 0.9 : 1;
    }
  }

  // A thought with a Focus workspace wears a thin lavender ring; once it has sub-tasks, the
  // ring fills in teal with progress and a small "2/5" label hangs below the orb.
  applyProgress(mesh, taskId) {
    if (mesh.userData.progress) {
      mesh.userData.progress.traverse((o) => {
        if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
        if (o.geometry && o.geometry !== this.markGeo) o.geometry.dispose();
      });
      mesh.remove(mesh.userData.progress);
      mesh.userData.progress = null;
    }
    mesh.userData.markMats = [];
    if (!Tasks.hasWorkspace(taskId)) return;
    const { done, total } = Tasks.childProgress(taskId);
    const group = new Group();
    const mat = (color, opacity) => {
      const m = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
      m.userData.baseOpacity = opacity;
      mesh.userData.markMats.push(m);
      return m;
    };
    group.add(new Mesh(this.markGeo, mat(0xc4b5fd, total ? 0.3 : 0.6)));
    if (total && done) {
      const arc = new Mesh(new TorusGeometry(ORB_R * 1.4, 0.005, 8, 64, (Math.PI * 2 * done) / total), mat(0x00d1c1, 0.95));
      arc.rotation.z = Math.PI / 2; // starts at the top and fills clockwise as seen from the front
      arc.scale.x = -1;
      group.add(arc);
    }
    if (total) {
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 80;
      const g = c.getContext('2d');
      g.font = '700 52px system-ui, -apple-system, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = done === total ? '#5eead4' : '#e9e7ff';
      g.fillText(`${done}/${total}`, 80, 42);
      const tex = new CanvasTexture(c);
      tex.colorSpace = SRGBColorSpace;
      const sm = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      sm.userData.baseOpacity = 1;
      mesh.userData.markMats.push(sm);
      const label = new Sprite(sm);
      label.scale.set(0.07, 0.035, 1);
      label.position.y = -ORB_R * 2.0;
      label.raycast = () => {};
      group.add(label);
    }
    group.traverse((o) => { o.raycast = () => {}; });
    mesh.add(group);
    mesh.userData.progress = group;
  }

  onOrbTap(taskId) {
    const now = performance.now();
    if (this.lastTap.id === taskId && now - this.lastTap.at < 400) return;
    this.lastTap = { id: taskId, at: now };
    if (taskId === this.selectedId) { this.closeCard(); return; }
    this.openCard(taskId);
  }

  orbEntity(taskId) {
    for (const entity of this.queries.orbs.entities) if (entity.getValue(Orb, 'taskId') === taskId) return entity;
    return null;
  }

  // Focus Mode closed: rebuild the orbit (fresh state, workspace ring) and bring back the controls.
  afterFocus() {
    this.rebuildPending = false;
    this.rebuildOrbit();
    if (this.inXR) this.setPanel(this.hudEntity, this.hud, true);
  }

  openCard(taskId) {
    const task = Tasks.get(taskId);
    if (!task) return;
    this.selectedId = taskId;
    this.cardTitle.setProperties({ text: task.title });
    this.cardContext.setProperties({ text: task.context || 'Not added yet' });
    this.cardNext.setProperties({ text: task.nextStep || 'Not added yet' });
    this.setPanel(this.cardEntity, this.card, true);
    this.styleOrbs();
    Sound.play('select', { pos: this.selectedOrbWorld(this.tmp2) || this.pipWorld(this.tmp2) });
  }

  closeCard() {
    this.selectedId = null;
    if (this.card) this.setPanel(this.cardEntity, this.card, false);
    if (this.queries) this.styleOrbs();
  }

  selectedOrbWorld(target) {
    for (const entity of this.queries.orbs.entities) {
      if (entity.getValue(Orb, 'taskId') === this.selectedId) return entity.object3D.getWorldPosition(target);
    }
    return null;
  }

  pipWorld(target) {
    return this.pipRoot.getWorldPosition(target);
  }

  /* ---------- placement and size ---------- */

  setScale(s) {
    this.pipScale = MathUtils.clamp(s, 0.3, 3);
    this.pipRoot.scale.setScalar(this.pipScale);
  }

  placePipAt(point) {
    this.pipRoot.position.copy(point);
    this.pipRoot.rotation.set(0, Math.atan2(this.head.x - point.x, this.head.z - point.z), 0);
    Sound.play(this.pipAppeared ? 'place' : 'signature', { pos: point });
    if (!this.pipAppeared) { this.pipAppeared = true; this.showWelcome(); }
  }

  // Pip appears about 85 cm in front of the viewer, a little below eye level, facing them.
  placeInFrontOfViewer() {
    this.headDir.y = 0;
    if (this.headDir.lengthSq() < 1e-4) this.headDir.set(0, 0, -1);
    this.headDir.normalize();
    this.tmp.copy(this.head).addScaledVector(this.headDir, 0.85);
    this.tmp.y = this.head.y - 0.75;
    this.placePipAt(this.tmp);
  }

  /* ---------- per frame ---------- */

  update(delta, time) {
    this.runDeferred();
    // The tracked head in XR; the browser camera in the 3D preview.
    const viewer = this.inXR ? this.player.head : this.camera;
    viewer.getWorldPosition(this.head);
    viewer.getWorldQuaternion(this.headQuat);
    this.headDir.set(0, 0, -1).applyQuaternion(this.headQuat);
    this.headUp.set(0, 1, 0).applyQuaternion(this.headQuat);
    Sound.setListener(this.head, this.headDir, this.headUp);

    if (this.inXR && this.xrFrame) {
      this.xrFrames++;
      if (this.pendingAutoPlace && this.xrFrames > 2) {
        this.pendingAutoPlace = false;
        this.placeInFrontOfViewer();
      }
    }

    // Orbs hold their places and breathe gently; a released orb eases back to its place.
    for (const entity of this.queries.orbs.entities) {
      const mesh = entity.object3D;
      const d = mesh.userData;
      if (d.held || entity.hasComponent(Grabbed)) continue;
      const y = Math.sin(time * 1.2 + d.phase) * 0.012;
      if (d.returning !== undefined) {
        d.returning = Math.min(1, d.returning + delta / 0.3);
        this.tmp.set(d.basePos.x, y, d.basePos.z);
        mesh.position.lerp(this.tmp, d.returning);
        if (d.returning >= 1) d.returning = undefined;
      } else {
        mesh.position.set(d.basePos.x, y, d.basePos.z);
      }
      mesh.scale.setScalar(d.scale || 1);
    }

    this.panelWant.forEach((want, entity) => this.applyPanel(entity, want.object, want.visible));
    this.pipWorld(this.pipPos);
    this.focus.update(delta);
    if (this.focus.active) { this.ring.visible = false; return; }
    if (this.card.visible) this.placeCard();
    if (this.hud.visible) this.placeFacing(this.hud, 0.42, 0.12);
    if (this.bubble.visible) this.placeFacing(this.bubble, 0.05, 1.0);

    if (this.inXR && this.xrFrame && this.world.xrReferenceSpace && this.world.xrSession) this.updateHands();
    else this.ring.visible = false;
  }

  // Place a panel relative to Pip's feet: `out` metres toward the viewer, `upBy` up, turned to face them.
  placeFacing(panel, out, upBy) {
    const s = this.pipScale;
    this.tmp.copy(this.head).sub(this.pipPos);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() < 1e-6) this.tmp.set(0, 0, 1);
    this.tmp.normalize();
    this.tmp2.copy(this.pipPos).addScaledVector(this.tmp, out * s);
    this.tmp2.y += upBy * s;
    panel.position.copy(panel.parent.worldToLocal(this.tmp2.clone()));
    this.tmp.set(this.head.x, this.tmp2.y, this.head.z);
    panel.lookAt(this.tmp);
  }

  // The card sits above its orb, slid sideways (as the viewer sees it) so it never covers Pip.
  placeCard() {
    const s = this.pipScale;
    const orbPos = this.selectedOrbWorld(this.tmp2);
    if (!orbPos) return;
    orbPos.y += 0.26 * s;
    const toCam = this.tmp.copy(this.head).sub(this.pipPos);
    toCam.y = 0;
    toCam.normalize();
    const right = this.tmpRight || (this.tmpRight = new Vector3());
    right.crossVectors(this.up, toCam).normalize();
    const lateral = this.tmp3 || (this.tmp3 = new Vector3());
    const d = lateral.copy(orbPos).sub(this.pipPos).dot(right);
    const minGap = (PIP_HALF_W + CARD_HALF_W + 0.03) * s;
    if (Math.abs(d) < minGap) orbPos.addScaledVector(right, (d >= 0 ? 1 : -1) * minGap - d);
    orbPos.addScaledVector(toCam, 0.1 * s);
    this.card.position.copy(this.card.parent.worldToLocal(orbPos.clone()));
    this.tmp.set(this.head.x, orbPos.y, this.head.z);
    this.card.lookAt(this.tmp);
  }

  /* ---------- hand gestures ---------- */

  joint(frame, hand, name, ref, target) {
    const space = hand.get(name);
    const pose = space && frame.getJointPose(space, ref);
    if (!pose) return null;
    const p = pose.transform.position;
    return target.set(p.x, p.y, p.z);
  }

  // "Pause" hand: open and flat (four straight fingers, thumb away from the index) with the
  // palm turned away from the viewer, like a stop sign. A relaxed hand rarely does both.
  isPauseHand(frame, hand, ref, side) {
    if (this.thumb.distanceTo(this.index) < 0.05) return false;
    for (const f of FINGERS) {
      for (let k = 0; k < 4; k++) if (!this.joint(frame, hand, `${f}-${FINGER_JOINTS[k]}`, ref, this.fingerPts[k])) return false;
      const [a, b, c, d] = this.fingerPts;
      const length = a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(d);
      if (length < 1e-4 || a.distanceTo(d) / length < 0.95) return false;
    }
    const [wrist, indexBase, pinkyBase] = this.fingerPts;
    if (!this.joint(frame, hand, 'wrist', ref, wrist) || !this.joint(frame, hand, 'index-finger-metacarpal', ref, indexBase)
      || !this.joint(frame, hand, 'pinky-finger-metacarpal', ref, pinkyBase)) return false;
    indexBase.sub(wrist);
    pinkyBase.sub(wrist);
    // Palm normal: index × pinky points out of the right palm (mirrored for the left hand).
    const palm = this.palmNormal.crossVectors(indexBase, pinkyBase).normalize();
    if (side === 'left') palm.negate();
    this.tmp.copy(this.headDir).setY(0).normalize();
    return palm.dot(this.tmp) > 0.5;
  }

  // Where this hand's ray would put Pip: a real upward surface, else the floor, else 1.2 m along
  // the ray (not when it points up at the ceiling).
  surfaceFor(side, target) {
    const probe = this.probes[side];
    if (probe && probe.getValue(EnvironmentRaycastTarget, 'xrHitTestResult')) {
      probe.object3D.getWorldQuaternion(this.rayQuat);
      // The probe's local Y follows the surface normal; only floors and tables count.
      if (this.tmp.set(0, 1, 0).applyQuaternion(this.rayQuat).y > 0.7) return probe.object3D.getWorldPosition(target);
    }
    const raySpace = this.player.raySpaces[side];
    if (!raySpace) return null;
    raySpace.getWorldPosition(this.rayOrigin);
    raySpace.getWorldQuaternion(this.rayQuat);
    this.rayDir.set(0, 0, -1).applyQuaternion(this.rayQuat);
    if (this.rayDir.y < -0.05) {
      const dist = -this.rayOrigin.y / this.rayDir.y; // local-floor: the floor is y = 0
      if (dist > 0 && dist < 6) return target.copy(this.rayOrigin).addScaledVector(this.rayDir, dist).setY(0);
    }
    if (this.rayDir.y > 0.35) return null;
    return target.copy(this.rayOrigin).addScaledVector(this.rayDir, 1.2);
  }

  // Each hand keeps ~0.6 s of where it pointed, so "point, then pause" uses the spot aimed at
  // before the palm came up (raising the palm swings the hand ray away).
  recordAim(state, now, ok) {
    const slot = state.hist[state.histI];
    slot.t = now;
    slot.ok = ok;
    if (ok) slot.p.copy(state.point);
    state.histI = (state.histI + 1) % state.hist.length;
  }

  aimBefore(state, time) {
    let best = null;
    for (const slot of state.hist) if (slot.ok && slot.t <= time && (!best || slot.t > best.t)) best = slot;
    return best;
  }

  updateHands() {
    const frame = this.xrFrame;
    const ref = this.world.xrReferenceSpace;
    const session = this.world.xrSession;
    const hovering = this.queries.hovered.entities.size > 0;
    const now = performance.now();
    let ringSide = null;
    let palmProgress = 0;
    const pinching = [];

    for (const src of session.inputSources) {
      const side = src.handedness;
      if (side !== 'left' && side !== 'right') continue;
      let state = this.handStates.get(src);
      if (!state) {
        state = { pinching: false, palm: null, palmUsed: false, mid: new Vector3(), point: new Vector3(), anchor: new Vector3(), wrist: new Vector3(),
          hist: Array.from({ length: 48 }, () => ({ t: 0, ok: false, p: new Vector3() })), histI: 0, ringAt: null };
        this.handStates.set(src, state);
      }
      const hasPoint = !!this.surfaceFor(side, state.point);
      state.ringAt = hasPoint ? state.point : null;
      if (!src.hand) {
        if (hasPoint && (ringSide === null || side === 'right')) ringSide = side;
        continue;
      }

      if (!this.joint(frame, src.hand, 'thumb-tip', ref, this.thumb) || !this.joint(frame, src.hand, 'index-finger-tip', ref, this.index)) continue;
      const gap = this.thumb.distanceTo(this.index);
      state.pinching = state.pinching ? gap < PINCH_OFF : gap < PINCH_ON;
      if (state.pinching) pinching.push(state.mid.copy(this.thumb).add(this.index).multiplyScalar(0.5));

      // Point and pause: point at a spot (the ring shows it), then hold up an open palm, like
      // "stop", and keep the hand still for a second. The ring stays on the spot you pointed at
      // and fills, then Pip moves there. Lower or close the hand to place again.
      const flat = !state.pinching && this.isPauseHand(frame, src.hand, ref, side);
      if (!flat) {
        state.palmUsed = false;
        state.palm = null;
        this.recordAim(state, now, hasPoint);
      } else if (!state.palmUsed && !hovering && !this.selectedId && !this.handZoom) {
        if (state.palm === null) {
          const aim = this.aimBefore(state, now - 350) || (hasPoint ? { p: state.point } : null);
          if (aim) {
            state.palm = now;
            state.anchor.copy(aim.p);
            state.wrist.copy(this.fingerPts[0]); // isPauseHand leaves the wrist position here
          }
        } else if (this.fingerPts[0].distanceTo(state.wrist) > PALM_STILL_M) {
          state.palm = null; // the hand moved: start the hold again
        }
        if (state.palm !== null) {
          const progress = (now - state.palm) / PALM_HOLD_MS;
          if (progress >= 1) {
            state.palm = null;
            state.palmUsed = true;
            this.placePipAt(state.anchor);
          } else if (progress >= palmProgress) {
            palmProgress = progress;
            ringSide = side;
            state.ringAt = state.anchor;
          }
        }
      }
      if (!palmProgress && state.ringAt && (ringSide === null || side === 'right')) ringSide = side;
    }

    // Pinch with both hands and pull them apart or together to resize Pip with its orbit.
    if (pinching.length === 2 && this.pipAppeared) {
      const gap = pinching[0].distanceTo(pinching[1]);
      if (!this.handZoom && gap > 0.03) this.handZoom = { gap, scale: this.pipScale };
      if (this.handZoom) this.setScale(this.handZoom.scale * gap / this.handZoom.gap);
    } else if (this.handZoom) {
      this.handZoom = null;
    }

    // Ring under the hand that is holding its palm (else the right hand), hidden over UI/orbs.
    let shown = false;
    if (ringSide && !hovering && !this.selectedId && !this.handZoom) {
      for (const src of session.inputSources) {
        if (src.handedness !== ringSide) continue;
        const state = this.handStates.get(src);
        if (!state || !state.ringAt) continue;
        this.ring.position.copy(state.ringAt);
        this.ring.scale.setScalar(1);
        shown = true;
        break;
      }
    }
    if (shown && !this.ring.visible) Sound.play('scan', { pos: this.ring.position });
    this.ring.visible = shown;
    this.ringFill.visible = shown && palmProgress > 0;
    if (this.ringFill.visible) this.ringFill.scale.setScalar(Math.max(0.05, palmProgress));
  }
}
