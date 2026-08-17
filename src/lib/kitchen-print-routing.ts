// Category-based kitchen ticket routing. Ice Cream + Drinks items get
// combined onto ONE ticket printed on the counter printer; Shwarma items
// get their own separate ticket, also on the counter printer; every other
// item still prints on the kitchen printer, exactly as before this file
// existed. Every print call site that used to send one combined ticket to
// settings.kitchenPrinter (POSPage placement, SalesPage/EditOrderPage add
// or remove deltas, CancelOrderModal's cancel ticket, DashboardShell's
// background watchers) now calls splitItemsForKitchenPrint first and fires
// one print-kitchen-receipt-data IPC call per non-empty group.
//
// Order line items (OrderPayload.items) never carry a category - only the
// live Product catalog does - so every call site needs its own
// name(+variation)->category lookup built from whatever product list it
// already has loaded. buildCategoryLookup below is that lookup builder,
// mirroring the categoryByItem pattern already used in RecordPage.tsx.
//
// This split is specific to Urban Crunch's own menu/printer setup (two
// physical printers, with Ice Cream/Drinks/Shwarma meant for the counter
// one) - this codebase is shared by other shop accounts too, and none of
// them asked for this. dispatchKitchenPrints below gates the whole split
// on isCategoryPrintRoutingEnabled() so every other shop keeps printing
// exactly one ticket to settings.kitchenPrinter, unchanged from before
// this feature existed - even if another shop happens to also have a
// category literally named "Drinks" or similar.
import { getAuthShop } from '@/lib/auth';

const URBAN_CRUNCH_SHOP_ID = '6a6cddec64e71ad746dd083a';

export function isCategoryPrintRoutingEnabled(): boolean {
  return getAuthShop()?.id === URBAN_CRUNCH_SHOP_ID;
}

const ICE_CREAM_DRINKS_CATEGORIES = new Set(['ice cream', 'drinks']);
const SHWARMA_CATEGORIES = new Set(['shwarma']);

export type KitchenPrintGroupName = 'kitchen' | 'counterIceCreamDrinks' | 'counterShwarma';

export function categoryPrintGroup(category: string | undefined | null): KitchenPrintGroupName {
  const normalized = (category || '').trim().toLowerCase();
  if (ICE_CREAM_DRINKS_CATEGORIES.has(normalized)) return 'counterIceCreamDrinks';
  if (SHWARMA_CATEGORIES.has(normalized)) return 'counterShwarma';
  return 'kitchen';
}

export function buildCategoryLookup(
  products: Array<{ name: string; variation?: string | null; category?: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  products.forEach((product) => {
    const variationKey = `${product.name}::${product.variation || ''}`;
    if (!map.has(variationKey)) map.set(variationKey, product.category || '');
    if (!map.has(product.name)) map.set(product.name, product.category || '');
  });
  return map;
}

export interface KitchenPrintGroups<T> {
  kitchen: T[];
  counterIceCreamDrinks: T[];
  counterShwarma: T[];
}

export function splitItemsForKitchenPrint<T extends { name: string; variation?: string | null }>(
  items: T[],
  categoryLookup: Map<string, string>,
): KitchenPrintGroups<T> {
  const groups: KitchenPrintGroups<T> = { kitchen: [], counterIceCreamDrinks: [], counterShwarma: [] };
  items.forEach((item) => {
    const category = categoryLookup.get(`${item.name}::${item.variation || ''}`) ?? categoryLookup.get(item.name);
    const group = categoryPrintGroup(category);
    groups[group].push(item);
  });
  return groups;
}

// Fires one print-kitchen-receipt-data IPC call per non-empty group, in
// order (kitchen first, then the two counter slips), so two tickets bound
// for the same physical counter printer don't interleave. `printOne` is
// supplied by the caller so each call site can keep using its own existing
// reportPrintOutcome/label/claim wiring - this function only decides WHICH
// item subsets go to WHICH printer name, not how the print itself is
// invoked or reported.
export async function dispatchKitchenPrints<T extends { name: string; variation?: string | null }>(
  items: T[],
  categoryLookup: Map<string, string>,
  printers: { kitchenPrinter?: string | null; counterPrinter?: string | null },
  printOne: (groupItems: T[], printerName: string, label: string) => Promise<unknown> | void,
): Promise<void> {
  if (!isCategoryPrintRoutingEnabled()) {
    // Every shop except Urban Crunch: exactly the pre-feature behavior -
    // one ticket, every item, to the kitchen printer only.
    if (items.length && printers.kitchenPrinter) {
      await printOne(items, printers.kitchenPrinter, 'Kitchen ticket');
    }
    return;
  }

  const groups = splitItemsForKitchenPrint(items, categoryLookup);

  if (groups.kitchen.length && printers.kitchenPrinter) {
    await printOne(groups.kitchen, printers.kitchenPrinter, 'Kitchen ticket');
  }
  if (groups.counterIceCreamDrinks.length && printers.counterPrinter) {
    await printOne(groups.counterIceCreamDrinks, printers.counterPrinter, 'Ice Cream/Drinks ticket');
  }
  if (groups.counterShwarma.length && printers.counterPrinter) {
    await printOne(groups.counterShwarma, printers.counterPrinter, 'Shwarma ticket');
  }
}
