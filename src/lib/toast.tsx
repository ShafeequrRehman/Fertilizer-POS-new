import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";
import { isTypingTarget } from "@/lib/keyboard-shortcuts";

// Lightweight in-house toast + confirm-dialog system. This replaces native
// window.alert()/window.confirm() everywhere in the app: those are
// synchronous/blocking browser dialogs which, in this Electron+Vite setup,
// were freezing/losing focus of whatever form input the user was typing in
// (reported as "alerts hang the inputs of any form"). Toasts and the
// confirm modal below are plain React state, so they never block input
// and never lose in-progress form state.

type ToastTone = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** "danger" renders the confirm button in red - use for destructive actions (delete, remove, suspend). */
  tone?: "danger" | "default";
}

interface ConfirmState extends ConfirmOptions {
  message: string;
  resolve: (value: boolean) => void;
}

interface PopupOptions {
  /** Defaults to "info". */
  tone?: ToastTone;
  title?: string;
  message: string;
}

interface PopupState extends PopupOptions {
  id: number;
}

interface ToastContextValue {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string) => void;
  };
  /** Promise-based replacement for window.confirm(). Resolves true/false when the user picks an option. */
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  // A centered, blocking popup (backdrop + X close button + OK button) for
  // moments that deserve more visual weight than a corner toast - e.g.
  // "you can't save this order" or "your order was saved" - see Technical
  // Requirements for Dynamic Popups #1. Fire-and-forget (no promise): the
  // user dismisses it via the X, the OK button, or clicking the backdrop.
  popup: (options: PopupOptions) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let idCounter = 0;

// Shared per-tone styling for both the toast stack and the popup dialog -
// a colored gradient "app icon" badge + a short bold label, matching an
// iOS notification banner's icon + app-name treatment rather than a flat
// pale alert box. `icon` takes a size so the same entry works for the
// toast's small badge and the popup's larger one.
const TONE_META: Record<ToastTone, { label: string; iconBg: string; icon: (size: number) => ReactNode }> = {
  success: { label: "Success", iconBg: "bg-gradient-to-br from-emerald-400 to-emerald-600", icon: (size) => <CheckCircle2 size={size} className="text-white" /> },
  error: { label: "Error", iconBg: "bg-gradient-to-br from-rose-400 to-rose-600", icon: (size) => <XCircle size={size} className="text-white" /> },
  info: { label: "Notice", iconBg: "bg-gradient-to-br from-indigo-400 to-indigo-600", icon: (size) => <Info size={size} className="text-white" /> },
  warning: { label: "Warning", iconBg: "bg-gradient-to-br from-amber-400 to-amber-600", icon: (size) => <AlertTriangle size={size} className="text-white" /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [popupState, setPopupState] = useState<PopupState | null>(null);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = ++idCounter;
    setToasts((prev) => [...prev, { id, tone, message }]);
    window.setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);

  const toast = {
    success: (message: string) => push("success", message),
    error: (message: string) => push("error", message),
    info: (message: string) => push("info", message),
    warning: (message: string) => push("warning", message),
  };

  const confirm = useCallback((message: string, options?: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ message, resolve, ...options });
    });
  }, []);

  function respond(value: boolean) {
    confirmState?.resolve(value);
    setConfirmState(null);
  }

  const popup = useCallback((options: PopupOptions) => {
    setPopupState({ id: ++idCounter, tone: options.tone ?? "info", title: options.title, message: options.message });
  }, []);

  // Keyboard Shortcuts: Esc, or now Backspace (Universal Popup-Close Hotkey
  // - see keyboard-shortcuts.ts's useBackspaceToClose, though this dialog
  // predates that hook and already had its own app-wide Esc listener, so
  // Backspace is just added alongside it here rather than switching this
  // file over), instantly closes whichever popup/confirm dialog is on top -
  // this is the shared modal system every "customer details required"/
  // "error"/success popup in the app already routes through (see this
  // file's own header comment), so this one listener covers all of them
  // app-wide instead of needing a close handler wired into every modal
  // individually. Backspace is guarded by isTypingTarget so it still just
  // deletes a character normally inside, say, a confirm dialog that ever
  // grows a text field - it only closes the dialog when focus isn't on
  // one. Popup (z-[220]) sits above Confirm (z-[210]), so it's checked
  // first when both would otherwise be open at once.
  useEffect(() => {
    function handleGlobalClose(event: KeyboardEvent) {
      if (event.key !== "Escape" && !(event.key === "Backspace" && !isTypingTarget(event.target))) return;
      if (popupState) {
        setPopupState(null);
        return;
      }
      if (confirmState) {
        respond(false);
      }
    }
    window.addEventListener("keydown", handleGlobalClose);
    return () => window.removeEventListener("keydown", handleGlobalClose);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupState, confirmState]);

  return (
    <ToastContext.Provider value={{ toast, confirm, popup }}>
      {children}

      {/* Toast stack - styled like an iOS/iPhone notification banner: a
          colored "app icon" badge, a bold short label, and the message
          underneath, all on a frosted glass card. */}
      <div className="fixed top-5 right-5 z-[200] flex w-full max-w-sm flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => {
          const meta = TONE_META[t.tone];
          return (
            <div
              key={t.id}
              className="glass-strong pointer-events-auto flex items-start gap-3 rounded-[22px] p-3.5"
            >
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_2px_6px_rgba(0,0,0,0.25)] ${meta.iconBg}`}>
                {meta.icon(16)}
              </div>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-[11px] font-black uppercase tracking-wide text-gray-500">{meta.label}</p>
                <p className="mt-0.5 text-sm font-bold leading-snug text-gray-900">{t.message}</p>
              </div>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className="shrink-0 rounded-full p-1 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-700"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Confirm (Yes/No) dialog */}
      {confirmState && (
        <div
          className="glass-overlay fixed inset-0 z-[210] flex items-center justify-center p-4"
          onClick={() => respond(false)}
        >
          <div
            className="glass-strong w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-[28px] p-6"
            onClick={(event) => event.stopPropagation()}
          >
            {confirmState.title ? (
              <h3 className="mb-2 text-lg font-black text-slate-900">{confirmState.title}</h3>
            ) : null}
            <p className="whitespace-pre-line text-sm font-bold leading-relaxed text-slate-600">{confirmState.message}</p>
            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={() => respond(false)}
                className="flex-1 rounded-2xl bg-slate-100 py-3.5 text-sm font-black text-slate-700 transition-colors hover:bg-slate-200"
              >
                {confirmState.cancelText || "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => respond(true)}
                className={`flex-1 rounded-2xl py-3.5 text-sm font-black text-white transition-colors ${
                  confirmState.tone === "danger" ? "bg-rose-600 hover:bg-rose-700" : "bg-indigo-600 hover:bg-indigo-700"
                }`}
              >
                {confirmState.confirmText || "Yes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Centered blocking popup - see PopupOptions above. Sits above the
          confirm dialog (z-index) since a popup can reasonably follow a
          confirm in the same flow (e.g. "cancel this order?" -> "Order
          cancelled"). */}
      {popupState && (
        <div
          className="glass-overlay fixed inset-0 z-[220] flex items-center justify-center p-4"
          onClick={() => setPopupState(null)}
        >
          <div
            className="glass-strong relative w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-[28px] p-6 text-center"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setPopupState(null)}
              aria-label="Close"
              className="glass-pill absolute right-4 top-4 rounded-full p-2 text-gray-500 transition hover:bg-white/70"
            >
              <X size={16} />
            </button>

            <div className={`mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_8px_18px_-6px_rgba(0,0,0,0.35)] ${TONE_META[popupState.tone ?? "info"].iconBg}`}>
              {TONE_META[popupState.tone ?? "info"].icon(28)}
            </div>

            {popupState.title ? (
              <h3 className="mb-1 text-lg font-black text-slate-900">{popupState.title}</h3>
            ) : null}
            <p className="whitespace-pre-line text-sm font-bold leading-relaxed text-slate-600">{popupState.message}</p>

            <button
              type="button"
              onClick={() => setPopupState(null)}
              className="glass-dark mt-6 w-full rounded-2xl py-3.5 text-sm font-black transition-colors hover:brightness-110"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  );
}

// This hook is intentionally exported alongside the ToastProvider
// component above - splitting it into a separate file would just add an
// import for every one of this hook's call sites for no real benefit.
// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
