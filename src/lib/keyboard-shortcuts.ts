import { useEffect } from 'react';

// Shared helpers for the app-wide Keyboard Shortcuts (Hotkeys) system.
//
// The system has two layers:
//   - Global (DashboardShell.tsx): page-switching shortcuts (F1/F2/F3) that
//     make sense no matter which dashboard page is currently open, wired up
//     once via a single document-level keydown listener.
//   - Local (each page that needs one, e.g. POSPage.tsx): shortcuts whose
//     meaning depends on that page's own state - Ctrl+S/Enter to save the
//     current order, Arrow keys to move the product-grid highlight, +/- to
//     bump the active cart item's quantity. These are only wired up while
//     that page is actually mounted.
//
// Both layers share the same core problem: a bare key like "s", "+", "-",
// an Arrow key, or Enter must NOT hijack normal typing/selection inside a
// text input, textarea, select, or contenteditable element (a customer's
// address, an order note, the product search box, etc.) - isTypingTarget
// below is the single guard both layers check before treating a keypress as
// a hotkey instead of ordinary input. Fix-keys (F1/F2/F3) are exempt from
// this guard since they never produce typed characters in the first place.
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// Universal Popup-Close Hotkey: every modal/popup in the app closes on
// Backspace, so a cashier mid-transaction never has to reach for the mouse
// just to dismiss one. Guarded by isTypingTarget for the same reason as
// every other hotkey here - a customer name, a note, a cash amount, etc.
// typed inside the popup must still let Backspace delete a character like
// normal; it only closes the popup when focus ISN'T on one of those fields
// (an unfocused body, a button, or nothing in particular). One hook, wired
// into every modal component across the app (Modal/ModalShell/
// CancelOrderModal/VariationPickerModal/etc.) so the behavior - and its
// typing guard - stays identical everywhere instead of being reimplemented
// per file. `active` defaults to true for a modal component that only ever
// renders while actually open; a page that instead toggles a modal via a
// boolean in its OWN JSX (rather than mounting/unmounting a component)
// passes that boolean through here so the listener isn't live while the
// popup is closed.
export function useBackspaceToClose(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Backspace' || isTypingTarget(event.target)) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, active]);
}

// Window CustomEvent names the global and local shortcut layers use to talk
// to each other across separate route pages (F3 needs to jump to the POS
// screen *and then* focus its search box, but DashboardShell has no direct
// reference to POSPage's search input - it only knows POSPage is listening
// for this event once it mounts).
export const FOCUS_PRODUCT_SEARCH_EVENT = 'pos-shortcuts:focus-search';
