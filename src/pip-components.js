import { createComponent, Types } from '@iwsdk/core';

/** A parked thought shown as a glowing orb in Pip's orbit. */
export const Orb = createComponent('Orb', {
  taskId: { type: Types.String, default: '' },
});

/** A sticky note on a Focus Mode board. */
export const Sticky = createComponent('Sticky', {
  noteId: { type: Types.String, default: '' },
});

/** A sub-task (child thought) orb on a Focus Mode board. */
export const ChildTask = createComponent('ChildTask', {
  childId: { type: Types.String, default: '' },
});
