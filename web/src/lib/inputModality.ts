/**
 * Which input device the user last reached for.
 *
 * Chromium propagates `:focus-visible` across a *programmatic* focus move: an
 * element focused by script inherits the state of the element focus came from.
 * Radix overlays hand focus back to their trigger on close, so a menu opened
 * and dismissed entirely with the mouse still lights that trigger's focus ring,
 * and leaves it lit until the next click. Overlays consult this to skip the
 * restore when no keyboard was involved.
 */

/** Held alone, a modifier is someone reaching for Cmd-Tab, not navigating. */
const MODIFIERS = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/**
 * Set on the document element while the focus the page currently holds arrived
 * by pointer. `tokens.css` reads it to keep the ring off a text field the mouse
 * focused -- the one control `:focus-visible` matches for either device, so a
 * selector alone cannot tell a click from a Tab. One element holds focus at a
 * time, so a single record says everything a mark on each element would, and
 * leaves nothing behind on every field the mouse has ever touched.
 */
const POINTER_FOCUS = 'data-pointer-focus';

let pointer = false;

if (typeof window !== 'undefined') {
  // Capture phase: a handler that stops propagation must not be able to hide
  // the interaction from this.
  window.addEventListener('pointerdown', () => { pointer = true; }, true);
  window.addEventListener(
    'keydown',
    (event) => {
      if (!MODIFIERS.has(event.key)) pointer = false;
    },
    true,
  );
  // Written when focus moves rather than read at paint: typing into a field is
  // a keydown, so a rule consulting the live flag would light a ring under the
  // user mid-sentence. Freezing it here answers what the ring actually asks,
  // which is how the control holding focus was reached.
  window.addEventListener(
    'focusin',
    () => { document.documentElement.toggleAttribute(POINTER_FOCUS, pointer); },
    true,
  );
}

export function lastInputWasPointer(): boolean {
  return pointer;
}
