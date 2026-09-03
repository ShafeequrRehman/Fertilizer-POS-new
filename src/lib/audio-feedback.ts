// Global UI Audio Feedback System: crisp, fast synthesized sound alerts for
// three specific system tasks - button/card clicks, toast/notification
// pop-ups, and print actions. Built entirely on the Web Audio API
// (oscillator synthesis) rather than shipping .wav/.mp3 asset files -
// there is nothing to fetch, no asset-loading race on first use, and no
// extra bytes in the build; every sound is a few milliseconds of code.
//
// One shared AudioContext, created lazily on first use (never at module
// load) - browsers refuse to let an AudioContext actually produce sound
// until it's been created or resumed inside a real user gesture (a click,
// a keydown), so creating it eagerly at import time would just leave it
// stuck "suspended" forever on some browsers. Every playXSound() call
// below defensively calls .resume() first for the same reason - the
// context can still end up suspended between calls on some platforms
// (tab backgrounded, etc).
let sharedContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  if (!sharedContext) {
    sharedContext = new AudioContextCtor();
  }
  return sharedContext;
}

// One short envelope-shaped tone: ramps up to `peakGain` almost instantly
// then decays to silence by `duration` - the "attack + decay" shape every
// short UI blip actually needs so it never clicks/pops at the start or cuts
// off abruptly at the end. `type` is the oscillator waveform (sine = soft,
// triangle/square = brighter/harder), `frequency` in Hz, optionally sliding
// to `endFrequency` over the tone's lifetime for a rising/falling "ding"
// shape rather than a flat beep.
function playTone(frequency: number, duration: number, options?: { type?: OscillatorType; peakGain?: number; endFrequency?: number; startAt?: number }) {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume();
    const startAt = ctx.currentTime + (options?.startAt || 0);
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();
    oscillator.type = options?.type || "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);
    if (options?.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(options.endFrequency, 1), startAt + duration);
    }
    const peak = options?.peakGain ?? 0.15;
    gainNode.gain.setValueAtTime(0, startAt);
    gainNode.gain.linearRampToValueAtTime(peak, startAt + 0.008);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  } catch {
    // Never let a sound-effect failure break the actual click/toast/print
    // it was meant to accompany - audio feedback is decoration, not a
    // required part of any of these flows.
  }
}

// Click Sound: a single crisp, very short tick - deliberately high-pitched
// and brief (40ms) so it never feels laggy or draws attention to itself on
// a rapid sequence of clicks (e.g. tapping through a product grid).
export function playClickSound() {
  playTone(1500, 0.045, { type: "square", peakGain: 0.05, endFrequency: 900 });
}

// Toast/Notification Sound: a pleasant two-note rising "ding" - a soft
// sine chime, not a harsh beep, so it doesn't feel like an error alarm even
// for a routine success toast.
export function playToastSound() {
  playTone(880, 0.12, { type: "sine", peakGain: 0.12 });
  playTone(1318.5, 0.16, { type: "sine", peakGain: 0.11, startAt: 0.09 });
}

// Print Sound: a distinct lower-pitched "processing" double-blip -
// deliberately different in character from both the click and toast
// sounds (lower register, square wave) so a cashier can tell by ear alone
// that a print just fired, without having to look at the screen.
export function playPrintSound() {
  playTone(520, 0.07, { type: "square", peakGain: 0.09 });
  playTone(340, 0.09, { type: "square", peakGain: 0.09, startAt: 0.08 });
}

// Installs ONE document-level click listener for the Click Sound - reuses
// the exact same selector src/index.css's global cursor/press-animation
// rule already applies to every generically "clickable" element in the
// app (button:not(:disabled), a, [role="button"], .clickable), so this
// needs zero changes to individual button/card components anywhere in the
// codebase; it automatically covers every one of them, present and future.
// Capture phase so it still fires even if some inner handler calls
// stopPropagation(). Idempotent - safe to call more than once (e.g. React
// StrictMode's double-invoke of effects in dev), since it removes any
// previous listener of its own first.
const CLICKABLE_SELECTOR = 'button:not(:disabled), a, [role="button"], .clickable';
let removePreviousListener: (() => void) | null = null;

export function installGlobalClickSound() {
  if (typeof document === "undefined") return;
  removePreviousListener?.();
  function handleClick(event: MouseEvent) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(CLICKABLE_SELECTOR)) playClickSound();
  }
  document.addEventListener("click", handleClick, true);
  removePreviousListener = () => document.removeEventListener("click", handleClick, true);
}
