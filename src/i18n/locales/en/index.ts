// Barrel: merges every per-namespace English dictionary file in this
// folder into the one `en` object src/i18n/index.tsx looks keys up in.
// Add a new namespace by importing it here and spreading it below - each
// namespace file is independent (own file, own top-level key), so this
// file rarely needs more than a one-line addition per new page/feature.
//
// IMPORTANT: a namespace file that exists on disk but is missing from
// this list is invisible to t() - every t('thatNamespace.key') call will
// silently render the raw key string instead of real text (t()'s
// fallback chain is active-language -> English -> the key itself, and if
// English doesn't have it either there's nothing left to fall back to).
// Always add the import+spread line in the SAME change that creates a
// new locale/<namespace>.ts file, never as a separate followup step.
import { common } from "./common";
import { sidebar } from "./sidebar";
import { dashboardShell } from "./dashboardShell";
import { pos } from "./pos";
import { sales } from "./sales";
import { record } from "./record";
import { purchase } from "./purchase";
import { reports } from "./reports";
import { productManagement } from "./productManagement";
import { ingredientStock } from "./ingredientStock";
import { accounting } from "./accounting";
import { dashboardHome } from "./dashboardHome";
import { dues } from "./dues";
import { editOrder } from "./editOrder";
import { employees } from "./employees";
import { payroll } from "./payroll";
import { settings } from "./settings";
import { shopClosingSummary } from "./shopClosingSummary";
import { waiterManagement } from "./waiterManagement";

export const en = {
  common,
  sidebar,
  dashboardShell,
  pos,
  sales,
  record,
  purchase,
  reports,
  productManagement,
  ingredientStock,
  accounting,
  dashboardHome,
  dues,
  editOrder,
  employees,
  payroll,
  settings,
  shopClosingSummary,
  waiterManagement,
};
