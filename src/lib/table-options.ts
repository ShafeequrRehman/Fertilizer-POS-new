// Shared between POSPage.tsx's Table Number dropdown and SalesPage.tsx's
// Change Table grid, so the two can never drift into offering different
// table lists. A shop's own custom labels (Shop.tables - see
// backend/models/Shop.js, fetched via fetchShopProfile/cached into the
// Local Hub's reference-data snapshot - see local-hub-api.ts's
// ReferenceDataSnapshot) always win when set; every shop that hasn't
// configured one (which, before this feature, was every shop) keeps
// getting the original plain numbered list, unchanged.
export const DEFAULT_TABLE_COUNT = 20;

export function getTableOptions(customTables: string[] | null | undefined): string[] {
  if (customTables && customTables.length > 0) return customTables;
  return Array.from({ length: DEFAULT_TABLE_COUNT }, (_, index) => String(index + 1));
}

// A plain numbered table ("5") still needs the "Table " prefix to read as
// a table at all - a custom label ("M1", "FM3", "OUT8") already reads
// fine on its own, and "Table M1" is just redundant. Only the default
// numbering is ever purely digits, so that's the one thing this needs to
// check - no shop config required here, just the value itself, which is
// what lets every existing "Table {x}" display spot (order cards, detail
// panels, the Change Table modal) pick this up without also having to
// thread the shop's table list through each one.
export function formatTableLabel(table: string): string {
  return /^\d+$/.test(table) ? `Table ${table}` : table;
}
