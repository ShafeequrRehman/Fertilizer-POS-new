// Global "no up/down increase/decrease on any numeric field" guard - the
// shop owner asked for every numeric input across the app to only ever
// take a typed (or Enter-confirmed) value, never bumped by a spinner
// click, an ArrowUp/ArrowDown keypress, or an accidental mouse-wheel
// scroll while it happens to be focused (all three are native
// <input type="number"> behaviors browsers provide for free, and all
// three are easy to trigger without meaning to - see index.css's own
// comment for why the visible spinner arrows are hidden; this is the
// other half, covering the keyboard/wheel paths CSS alone can't reach).
//
// One pair of document-level, capture-phase listeners installed once
// here rather than touching each of the ~18 files with a
// type="number" input - see audio-feedback.ts's installGlobalClickSound
// for the exact same pattern this mirrors. Idempotent (removes any
// previous listeners of its own first) - safe to call more than once,
// e.g. React StrictMode's double-invoke of effects in dev.
let removePreviousListeners: (() => void) | null = null;

function isNumberInput(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.type === 'number';
}

export function installNumberInputArrowGuard() {
  if (typeof document === 'undefined') return;
  removePreviousListeners?.();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    if (isNumberInput(event.target)) event.preventDefault();
  }

  // Only blocks the wheel-scroll step when the number input under the
  // cursor is the one actually focused - so scrolling the page past an
  // unfocused numeric field (the normal case) still scrolls the page
  // exactly as before; it's only "I'm typed into this field and my mouse
  // happens to be over it while the page scrolls" that this stops from
  // silently changing the value.
  function handleWheel(event: WheelEvent) {
    if (isNumberInput(event.target) && document.activeElement === event.target) {
      event.preventDefault();
    }
  }

  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('wheel', handleWheel, { capture: true, passive: false });
  removePreviousListeners = () => {
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('wheel', handleWheel, true);
  };
}
