import { World, VisibilityState } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PipSystem } from './pip-system.js';
import { Sound } from './sound.js';
import { Tasks } from './tasks.js';

const $ = (id) => document.getElementById(id);

function renderStats() {
  $('active-count').textContent = Tasks.orbit().length;
  $('done-count').textContent = Tasks.completedCount();
}
renderStats();
Tasks.onChange(renderStats);

$('capture').addEventListener('submit', (e) => {
  e.preventDefault();
  if (Tasks.park($('thought').value)) {
    $('thought').value = '';
    Sound.play('park');
  }
});

World.create($('scene-container'), projectOptions).then((world) => {
  world.registerSystem(PipSystem);

  const enter = $('enter');
  const note = $('note');
  const xr = navigator.xr;
  const check = xr && xr.isSessionSupported ? xr.isSessionSupported('immersive-ar') : Promise.resolve(false);
  check.catch(() => false).then((ok) => {
    enter.disabled = !ok;
    note.textContent = ok
      ? 'Opens Pip in a calm space around you. Allow hand tracking if asked.'
      : window.isSecureContext
        ? 'The immersive space needs a mixed reality headset browser (Meta Quest). This 3D preview still works: click an orb, then Focus.'
        : 'Passthrough needs an HTTPS link.';
  });
  enter.addEventListener('click', () => {
    Sound.unlock();
    world.launchXR();
  });

  // The capture panel is a page overlay, so hide it while immersed.
  world.visibilityState.subscribe((state) => {
    $('home').hidden = state !== VisibilityState.NonImmersive;
  });
});
