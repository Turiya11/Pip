import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  SphereGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';

/**
 * Pip's calm deep-space surroundings: a midnight-indigo sky dome with faint nebula and a
 * sparse layer of nearer stars for depth. The dome is opaque, so in a passthrough session
 * it covers the room (the immersive look); hiding it reveals the room.
 */
export function createCosmos() {
  const group = new Group();
  group.name = 'Cosmos';

  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 1024;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, c.height);
  sky.addColorStop(0, '#07051a');
  sky.addColorStop(0.45, '#161036');
  sky.addColorStop(0.55, '#1b1340');
  sky.addColorStop(1, '#0a0720');
  g.fillStyle = sky;
  g.fillRect(0, 0, c.width, c.height);
  // A few soft violet clouds, kept dim so they read as depth rather than decoration.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9; i++) {
    const x = rand() * c.width, y = c.height * (0.3 + rand() * 0.4), r = 180 + rand() * 260;
    const neb = g.createRadialGradient(x, y, 0, x, y, r);
    neb.addColorStop(0, i % 3 ? 'rgba(124, 58, 237, 0.10)' : 'rgba(56, 120, 220, 0.08)');
    neb.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = neb;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 1400; i++) {
    const a = 0.25 + rand() * 0.6;
    g.fillStyle = `rgba(233, 231, 255, ${a})`;
    const s = rand() < 0.94 ? 1 : 2;
    g.fillRect(rand() * c.width, rand() * c.height, s, s);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  const domeMat = new MeshBasicMaterial({ map: tex, side: BackSide, depthWrite: false, fog: false });
  const dome = new Mesh(new SphereGeometry(60, 64, 32), domeMat);
  dome.name = 'Sky Dome';
  dome.renderOrder = -10;
  dome.raycast = () => {};
  group.add(dome);

  // Nearer stars at 12–30 m give gentle parallax when the head moves.
  const pts = [];
  for (let i = 0; i < 420; i++) {
    const u = rand() * 2 - 1, th = rand() * Math.PI * 2, r = 12 + rand() * 18;
    const s = Math.sqrt(1 - u * u);
    pts.push(Math.cos(th) * s * r, u * r * 0.8 + 2, Math.sin(th) * s * r);
  }
  const starGeo = new BufferGeometry();
  starGeo.setAttribute('position', new Float32BufferAttribute(pts, 3));
  const starMat = new PointsMaterial({ color: 0xe9e7ff, size: 0.06, transparent: true, opacity: 0.7, depthWrite: false, blending: AdditiveBlending });
  const stars = new Points(starGeo, starMat);
  stars.name = 'Near Stars';
  stars.raycast = () => {};
  group.add(stars);

  const full = new Color(1, 1, 1);
  return {
    group,
    /** 1 = normal sky, lower values dim it (Focus Mode). */
    setDim(f) {
      domeMat.color.copy(full).multiplyScalar(f);
      starMat.opacity = 0.7 * f;
    },
  };
}
