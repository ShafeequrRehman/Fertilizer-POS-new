import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from "lucide-react";

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

interface ToastContextValue {
  toast: {
    success: (message: string) => void;
    error: (message: string) => void;
    info: (message: string) => void;
    warning: (message: string) => void;
  };
  /** Promise-based replacement for window.confirm(). Resolves true/false when the user picks an option. */
  confirm: (message: string, options?: ConfirmOptions) => Promise<boolean>;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let idCounter = 0;

const TONE_STYLES: Record<ToastTone, { bg: string; border: string; text: string; icon: ReactNode }> = {
  success: { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-700", icon: <CheckCircle2 size={18} className="text-emerald-500" /> },
  error: { bg: "bg-rose-50", border: "border-rose-200", text: "text-rose-700", icon: <XCircle size={18} className="text-rose-500" /> },
  info: { bg: "bg-indigo-50", border: "border-indigo-200", text: "text-indigo-700", icon: <Info size={18} className="text-indigo-500" /> },
  warning: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", icon: <AlertTriangle size={18} className="text-amber-500" /> },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

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

  return (
    <ToastContext.Provider value={{ toast, confirm }}>
      {children}

      {/* Toast stack */}
      <div className="fixed top-5 right-5 z-[200] flex w-full max-w-sm flex-col gap-2.5 pointer-events-none">
        {toasts.map((t) => {
          const style = TONE_STYLES[t.tone];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-3 rounded-2xl border ${style.border} ${style.bg} px-4 py-3.5 shadow-lg`}
            >
              <div className="mt-0.5 shrink-0">{style.icon}</div>
              <p className={`flex-1 text-sm font-bold ${style.text}`}>{t.message}</p>
              <button
                type="button"
                onClick={() => dismiss(t.id)}
                className={`shrink-0 opacity-60 hover:opacity-100 ${style.text}`}
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Confirm (Yes/No) dialog */}
      {confirmState && (
        <div
          className="fixed inset-0 z-[210] flex items-center justify-center bg-black/50 p-4"
          onClick={() => respond(false)}
        >
          <div
            className="w-full max-w-sm max-h-[85vh] overflow-y-auto rounded-[28px] bg-white p-6 shadow-2xl"
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
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
