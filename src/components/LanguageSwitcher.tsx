import { Languages } from "lucide-react";
import { useLanguage } from "@/i18n";

// The single, always-visible language toggle for the whole shop dashboard/
// POS app - rendered once in DashboardShell.tsx's header, which every
// /dashboard/* route (including POS itself) renders inside, so it reads as
// "at the top of the POS interface" without needing a second copy on every
// individual page. Switching is instant (plain React state - see
// useLanguage()/LanguageProvider in src/i18n/index.tsx) and persists to
// localStorage, so a refresh or reopen keeps the chosen language.
export function LanguageSwitcher({ className = "" }: { className?: string }) {
  const { language, setLanguage, t } = useLanguage();

  return (
    <div
      role="group"
      aria-label={t("common.language")}
      className={`glass-pill flex items-center gap-0.5 rounded-full p-1 ${className}`}
    >
      <Languages size={13} className="mx-1 shrink-0 text-gray-400" />
      <button
        type="button"
        onClick={() => setLanguage("en")}
        aria-pressed={language === "en"}
        className={`rounded-full px-2.5 py-1 text-[11px] font-black uppercase tracking-wide transition-colors ${
          language === "en" ? "bg-indigo-600 text-white shadow-sm" : "text-gray-600 hover:bg-white/70"
        }`}
      >
        EN
      </button>
      <button
        type="button"
        onClick={() => setLanguage("ur")}
        aria-pressed={language === "ur"}
        lang="ur"
        className={`rounded-full px-2.5 py-1 text-[11px] font-black transition-colors ${
          language === "ur" ? "bg-indigo-600 text-white shadow-sm" : "text-gray-600 hover:bg-white/70"
        }`}
      >
        اردو
      </button>
    </div>
  );
}
