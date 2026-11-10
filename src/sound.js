/**
 * Pip's sounds, synthesized with the Web Audio API (no audio files), ported from the web app.
 * In the headset each sound comes from where it happens (HRTF panning).
 * Sound.play('name', { pos }) with a world-space position.
 */
const SOUND_KEY = 'pip_sound_v1';

export const Sound = (() => {
  let ctx = null;
  let out = null;
  let noiseBuf = null;
  let prefs = { on: true, volume: 0.6 };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(SOUND_KEY) || '{}') };
  } catch (e) {}
  const lastPlayed = {};
  const recent = [];

  // Minimum gap between two plays of the same sound (ms), so repeated events never stack.
  const COOLDOWN = { signature: 1500, welcome: 4000, park: 800, select: 140, scan: 8000, place: 600, complete: 900, ready: 500, focusIn: 1200, focusOut: 1200, delete: 600 };

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      const master = ctx.createGain();
      master.gain.value = prefs.on ? prefs.volume : 0;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.knee.value = 24;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;
      master.connect(comp);
      comp.connect(ctx.destination);
      out = master;
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) {
      ctx = null;
    }
    return ctx;
  }

  // Browsers only allow audio after a user gesture: create/resume on the first one.
  function unlock() {
    const c = ensure();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }
  ['pointerdown', 'touchend', 'keydown'].forEach((ev) => document.addEventListener(ev, unlock, { capture: true, passive: true }));

  function route(opts) {
    if (opts.pos && ctx.createPanner) {
      const p = ctx.createPanner();
      p.panningModel = 'HRTF';
      p.distanceModel = 'inverse';
      p.refDistance = 0.6;
      p.rolloffFactor = 0.8;
      if (p.positionX) {
        p.positionX.value = opts.pos.x;
        p.positionY.value = opts.pos.y;
        p.positionZ.value = opts.pos.z;
      } else p.setPosition(opts.pos.x, opts.pos.y, opts.pos.z);
      p.connect(out);
      return p;
    }
    return out;
  }

  function bell(dest, t, freq, dur, gain, { glideTo = 0, overtone = 0.22 } = {}) {
    [[1, 1], [2.01, overtone], [3.0, overtone * 0.35]].forEach(([mult, g]) => {
      if (g <= 0) return; // exponential ramps can't target 0, so skip silent overtones
      const o = ctx.createOscillator();
      const v = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq * mult, t);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo * mult, t + dur * 0.6);
      v.gain.setValueAtTime(0.0001, t);
      v.gain.exponentialRampToValueAtTime(gain * g, t + 0.012);
      v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(v);
      v.connect(dest);
      o.start(t);
      o.stop(t + dur + 0.05);
    });
  }
  function air(dest, t, dur, gain, { type = 'bandpass', freq = 4000, q = 1.2 } = {}) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t);
    const v = ctx.createGain();
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3);
    v.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(v);
    v.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5, G6 = 1567.98, A6 = 1760;
  const SOUNDS = {
    signature: (d, t) => { air(d, t, 0.4, 0.02, { freq: 6000 }); bell(d, t, C6, 0.9, 0.2); bell(d, t + 0.14, G6, 1.1, 0.18); },
    welcome: (d, t) => { bell(d, t, C6, 1.0, 0.1); bell(d, t + 0.2, G6, 1.2, 0.09); },
    park: (d, t) => { bell(d, t, E6, 0.5, 0.1); bell(d, t + 0.09, 987.77, 0.55, 0.09); bell(d, t + 0.18, G5, 0.7, 0.08);
      bell(d, t + 0.26, 220, 0.45, 0.06, { glideTo: 180, overtone: 0 }); air(d, t + 0.26, 0.3, 0.012, { type: 'lowpass', freq: 500, q: 0.7 }); },
    select: (d, t) => { bell(d, t, A6, 0.28, 0.11, { overtone: 0.15 }); },
    scan: (d, t) => { bell(d, t, 1975.5, 0.35, 0.045, { overtone: 0.05 }); bell(d, t + 0.18, 1975.5, 0.3, 0.02, { overtone: 0 }); },
    place: (d, t) => { bell(d, t, 165, 0.55, 0.13, { glideTo: 110, overtone: 0 }); bell(d, t + 0.02, C5, 0.6, 0.05, { overtone: 0.1 }); air(d, t, 0.22, 0.02, { type: 'lowpass', freq: 380, q: 0.7 }); },
    // Delete: very subtle and low, a quiet confirmation.
    delete: (d, t) => { bell(d, t, 220, 0.25, 0.06, { glideTo: 165, overtone: 0 }); },
    // Grabbed orb is close enough to drop: a tiny glass tick.
    ready: (d, t) => { bell(d, t, E6, 0.18, 0.05, { overtone: 0.05 }); },
    // Entering Focus Mode: a soft airy swell that settles on a low, open fifth.
    focusIn: (d, t) => { air(d, t, 0.7, 0.018, { type: 'lowpass', freq: 900, q: 0.7 }); bell(d, t + 0.05, C5, 1.1, 0.08); bell(d, t + 0.22, G5, 1.3, 0.07); bell(d, t + 0.4, C6, 1.4, 0.04); },
    // Back to the orbit: the same notes, descending and quieter.
    focusOut: (d, t) => { bell(d, t, C6, 0.6, 0.04); bell(d, t + 0.12, G5, 0.8, 0.06); bell(d, t + 0.26, C5, 1.0, 0.07); },
    complete: (d, t) => { bell(d, t, 261.63, 0.9, 0.05, { overtone: 0 }); bell(d, t, C5, 0.7, 0.1); bell(d, t + 0.1, E5, 0.75, 0.1); bell(d, t + 0.2, G5, 1.0, 0.12); },
  };

  function play(name, opts = {}) {
    try {
      if (!prefs.on || !SOUNDS[name]) return;
      const c = ctx; // never create audio before a user gesture
      if (!c || c.state !== 'running') return;
      const now = performance.now();
      if (now - (lastPlayed[name] || 0) < (COOLDOWN[name] || 150)) return;
      while (recent.length && now - recent[0] > 350) recent.shift();
      if (recent.length >= 3) return; // more than 3 sounds in 350 ms would be noise
      lastPlayed[name] = now;
      recent.push(now);
      SOUNDS[name](route(opts), c.currentTime + 0.01);
    } catch (e) {
      /* audio is optional: never let it break an interaction */
    }
  }

  function setListener(pos, fwd, up) {
    if (!ctx) return;
    const l = ctx.listener;
    try {
      if (l.positionX) {
        l.positionX.value = pos.x; l.positionY.value = pos.y; l.positionZ.value = pos.z;
        l.forwardX.value = fwd.x; l.forwardY.value = fwd.y; l.forwardZ.value = fwd.z;
        l.upX.value = up.x; l.upY.value = up.y; l.upZ.value = up.z;
      } else {
        l.setPosition(pos.x, pos.y, pos.z);
        l.setOrientation(fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
      }
    } catch (e) {}
  }

  return { play, setListener, unlock };
})();
