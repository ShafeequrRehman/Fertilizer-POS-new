// Barrel: merges every per-namespace Urdu dictionary file in this folder
// into the one `ur` object src/i18n/index.tsx looks keys up in. See
// en/index.ts's own comment - a namespace missing from this list is
// invisible to t() and renders as a raw key string, so add the
// import+spread line in the SAME change that creates a new
// locale/<namespace>.ts file. Urdu doesn't need every English namespace
// yet (t() falls back to English for anything not listed here), but
// once a namespace's ur/<name>.ts file exists it must be added below.
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
import { dues } from "./dues";
import { editOrder } from "./editOrder";
import { employees } from "./employees";
import { payroll } from "./payroll";
import { settings } from "./settings";
import { shopClosingSummary } from "./shopClosingSummary";

export const ur = {
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
  dues,
  editOrder,
  employees,
  payroll,
  settings,
  shopClosingSummary,
};
