import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { en } from "@/i18n/locales/en";
import { ur } from "@/i18n/locales/ur";

// Centralized i18n system for the shop dashboard/POS app (English + Urdu).
//
// Deliberately NOT a third-party library (react-i18next, etc.) - this app's
// build/typecheck can't install new npm packages in every environment it's
// verified from, so this is a small, dependency-free equivalent: one nested
// string dictionary per language (src/i18n/locales/en, src/i18n/locales/ur -
// each split into one file per page/feature, re-exported from that
// language's own index.ts), a dotted-path lookup (`t('pos.addToCart')`),
// `{{var}}` interpolation for dynamic values, localStorage persistence, and
// an immediate `dir`/`lang` flip on <html> for RTL - all through one
// `useLanguage()` hook. No page reload is ever needed: changing the
// language just updates React context state, and every component reading
// `t()`/`language` re-renders with the new strings on the same render pass
// that flips `document.documentElement.dir`.
//
// Scope: covers the shop-facing app (everything under /dashboard, i.e. the
// sidebar + POS + Sales + Record + Reports + Settings + every other
// dashboard page/modal/toast) plus the Login screen. The Super Admin
// console (/superadmin - a separate platform-operator tool, not something
// shop staff use) and the customer-facing QR ordering page
// (CustomerOrderPage.tsx, its own distinct audience) are intentionally out
// of scope for this pass and keep their existing English-only text.
export type Language = "en" | "ur";

const DICTS: Record<Language, Translations> = { en, ur };

const STORAGE_KEY = "pos_language";

function getByPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((accumulator, part) => {
    if (accumulator && typeof accumulator === "object" && part in (accumulator as Record<string, unknown>)) {
      return (accumulator as Record<string, unknown>)[part];
    }
    return undefined;
  }, source);
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function readInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "ur") return stored;
  } catch {
    // localStorage unavailable (private mode, disabled storage, etc.) -
    // fall back to the default below, same as a first-ever visit.
  }
  return "en";
}

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  toggleLanguage: () => void;
  /** 'rtl' for Urdu, 'ltr' for English - mirrors document.documentElement.dir. */
  dir: "ltr" | "rtl";
  isRtl: boolean;
  /**
   * Looks up a dotted translation key (e.g. "pos.addToCart") in the active
   * language's dictionary, falling back to English and then to the key
   * itself if a translation is missing, so a not-yet-translated string
   * never renders as blank. `vars` fills in `{{placeholders}}` inside the
   * translated string for dynamic values (names, counts, amounts, etc.).
   */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readInitialLanguage);

  // Runs on mount too (not just on change) so a page loaded directly with
  // Urdu already saved in localStorage gets dir="rtl"/lang="ur" on <html>
  // immediately, before the user ever touches the switcher.
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ur" ? "rtl" : "ltr";
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Ignore - persistence is a nice-to-have, not required for the
      // language switch itself to work for the rest of this session.
    }
  }, [language]);

  function setLanguage(next: Language) {
    setLanguageState(next);
  }

  function toggleLanguage() {
    setLanguageState((previous) => (previous === "en" ? "ur" : "en"));
  }

  function t(key: string, vars?: Record<string, string | number>): string {
    const active = getByPath(DICTS[language], key);
    const fallback = getByPath(DICTS.en, key);
    const raw = typeof active === "string" ? active : typeof fallback === "string" ? fallback : key;
    return interpolate(raw, vars);
  }

  const value: LanguageContextValue = {
    language,
    setLanguage,
    toggleLanguage,
    dir: language === "ur" ? "rtl" : "ltr",
    isRtl: language === "ur",
    t,
  };

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error("useLanguage() must be used within a <LanguageProvider>.");
  }
  return context;
}

// Every per-namespace dictionary file (src/i18n/locales/en/*.ts) exports a
// plain object of strings (nesting allowed for grouping, e.g.
// `orderType: { takeAway: '...', delivery: '...' }`). Kept loose (not a
// strict shared shape between en/ur) since Urdu files are added
// incrementally, one namespace at a time - `t()`'s fallback-to-English
// above covers any key a namespace hasn't been translated for yet.
export type Translations = Record<string, unknown>;
