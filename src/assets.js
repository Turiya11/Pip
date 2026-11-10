import { AssetType, defineAssets } from '@iwsdk/core';
import { createProceduralPip } from './scene-assets/pip.scene-asset.js';

const publicAssetUrl = (filePath) => `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;
const uikitml = (fileName, name) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'pip-procedural': createProceduralPip(),
  // Same astronaut the web app falls back to. Loaded lazily; the procedural Pip stays if it fails.
  'pip-astronaut': {
    url: 'https://modelviewer.dev/shared-assets/models/Astronaut.glb',
    type: AssetType.GLTF,
    name: 'Pip Astronaut',
    priority: 'lazy',
  },
  'task-card': uikitml('task-card.uikitml', 'Task Card'),
  'pip-hud': uikitml('pip-hud.uikitml', 'Pip Controls'),
  'welcome-bubble': uikitml('welcome-bubble.uikitml', 'Welcome Bubble'),
  'focus-board': uikitml('focus-board.uikitml', 'Focus Board'),
  'item-actions': uikitml('item-actions.uikitml', 'Item Actions'),
  'note-editor': uikitml('note-editor.uikitml', 'Note Editor'),
});
