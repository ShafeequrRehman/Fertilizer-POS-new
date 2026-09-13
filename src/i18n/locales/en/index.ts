// Barrel: merges every per-namespace English dictionary file in this
// folder into the one `en` object src/i18n/index.tsx looks keys up in.
// Add a new namespace by importing it here and spreading it below - each
// namespace file is independent (own file, own top-level key), so this
// file rarely needs more than a one-line addition per new page/feature.
import { common } from "./common";
import { sidebar } from "./sidebar";
import { dashboardShell } from "./dashboardShell";

export const en = {
  common,
  sidebar,
  dashboardShell,
};
