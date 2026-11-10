import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
} from '@iwsdk/core';

/**
 * Pip, the procedural astronaut (0.8 m tall, feet at the origin, facing +Z).
 * Always available; the app swaps in the astronaut glTF when it loads.
 */
export function createProceduralPip() {
  const group = new Group();
  group.name = 'Pip Procedural';
  const suitMat = new MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.35, metalness: 0.05 });
  const visorMat = new MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.05, metalness: 0.9, emissive: 0x0c4a6e, emissiveIntensity: 0.6 });
  const purpleMat = new MeshStandardMaterial({ color: 0xa855f7, roughness: 0.3 });
  const glowMat = new MeshBasicMaterial({ color: 0xff7edb });

  const body = new Mesh(new CapsuleGeometry(0.15, 0.16, 12, 24), suitMat);
  body.position.y = 0.24;
  const helmet = new Mesh(new SphereGeometry(0.15, 32, 24), suitMat);
  helmet.position.y = 0.52;
  const visor = new Mesh(new SphereGeometry(0.115, 32, 24), visorMat);
  visor.scale.set(1.05, 0.78, 0.6);
  visor.position.set(0, 0.53, 0.085);
  const antenna = new Mesh(new CylinderGeometry(0.006, 0.006, 0.08, 8), purpleMat);
  antenna.position.set(0, 0.7, 0);
  const antennaTip = new Mesh(new SphereGeometry(0.022, 16, 16), glowMat);
  antennaTip.position.set(0, 0.75, 0);
  const pack = new Mesh(new BoxGeometry(0.22, 0.24, 0.1), purpleMat);
  pack.position.set(0, 0.28, -0.16);
  const armGeo = new CapsuleGeometry(0.045, 0.1, 6, 12);
  const armL = new Mesh(armGeo, suitMat);
  armL.position.set(-0.18, 0.27, 0);
  armL.rotation.z = -0.35;
  const armR = new Mesh(armGeo, suitMat);
  armR.position.set(0.18, 0.27, 0);
  armR.rotation.z = 0.35;
  const bootGeo = new CapsuleGeometry(0.05, 0.03, 6, 12);
  const bootL = new Mesh(bootGeo, purpleMat);
  bootL.position.set(-0.07, 0.05, 0.01);
  const bootR = new Mesh(bootGeo, purpleMat);
  bootR.position.set(0.07, 0.05, 0.01);

  group.add(body, helmet, visor, antenna, antennaTip, pack, armL, armR, bootL, bootR);
  return group;
}
