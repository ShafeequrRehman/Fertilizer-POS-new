import { useEffect, useMemo, useState } from 'react';
import {
  Truck, PackagePlus, Clock, ChevronRight, Search, Filter, AlertCircle,
  CheckCircle2, Box, ArrowRight, Plus, Trash2, X, Download, FileSpreadsheet, MessageCircle,
} from 'lucide-react';
import {
  fetchSuppliers, createSupplier, fetchIngredients, fetchIngredientPurchases,
  fetchCompanyLedger, createPurchaseOrder, receivePurchaseOrder, sendWhatsappDocument,
} from '@/lib/pos-api';
import { CompanyLedgerEntry, Ingredient, IngredientPurchase, PurchaseOrderGroup, PurchaseOrderReceiveItemInput, Supplier } from '@/lib/pos-types';
import { useToast } from '@/lib/toast';
import { useBackspaceToClose } from '@/lib/keyboard-shortcuts';
import { getAuthShop } from '@/lib/auth';
import { ReportPdfDocument, downloadPdfDocument, pdfDocumentToBase64 } from '@/lib/pdf-export';
import { downloadExcelWorkbook, type ExcelCell, type ExcelSheet } from '@/lib/excel-export';
import { useLanguage } from '@/i18n';

function formatMoney(amount: number) {
  return `Rs ${Math.round(amount).toLocaleString()}`;
}

// en-CA formats as YYYY-MM-DD in the browser's LOCAL time zone - matches
// the date input's own value format and the backend's plain YYYY-MM-DD
// query-param convention (same helper as ReportsPage.tsx's own).
function toDateKey(date: Date) {
  return date.toLocaleDateString('en-CA');
}

function formatDisplayDate(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// Date + time (not just date) - a supplier can deliver more than once a day,
// so the Per-Supplier Dashboard's exports need to disambiguate which batch
// is which. Same pattern as IngredientStockSection.tsx's own
// formatPurchaseDateTime.
function formatPurchaseDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Shop Name letterhead row for the Excel exports below - same
// reasoning/pattern as IngredientStockSection.tsx's own
// buildRestaurantNameRow (a sheet forwarded straight to a supplier on
// WhatsApp needs to say which shop it's from with no other context).
function buildRestaurantNameRow(columnCount: number, t: (key: string, vars?: Record<string, string | number>) => string): ExcelCell[] {
  const restaurantName = getAuthShop()?.name || t('purchase.defaultShopName');
  const row: ExcelCell[] = [{ value: restaurantName, style: { bold: true, fontSize: 14 } }];
  for (let i = 1; i < columnCount; i += 1) row.push({ value: '' });
  return row;
}

// Live generation timestamp, top-right of every exported Excel sheet - same
// pattern as IngredientStockSection.tsx's own buildGeneratedAtRow.
function buildGeneratedAtRow(columnCount: number, t: (key: string, vars?: Record<string, string | number>) => string): ExcelCell[] {
  const row: ExcelCell[] = Array.from({ length: Math.max(columnCount - 1, 0) }, () => ({ value: '' }));
  const generatedAt = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
  row.push({ value: t('purchase.generatedAt', { date: generatedAt }), style: { align: 'Right', color: '6B7280', fontSize: 9 } });
  return row;
}

// Comprehensive Analytics Filters: Daily / Monthly / Custom - a trimmed
// version of ReportsPage.tsx's own Daily/Monthly/Yearly/Custom preset
// picker (no Yearly here - not part of this page's spec), same
// toDateKey/YYYY-MM-DD convention so the backend's existing date-range
// query params (ingredientPurchaseController.getPurchases) need no changes
// to support it.
type Preset = 'daily' | 'monthly' | 'custom';
function computePresetRange(preset: Preset): { from: string; to: string } {
  const now = new Date();
  if (preset === 'monthly') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: toDateKey(first), to: toDateKey(now) };
  }
  return { from: toDateKey(now), to: toDateKey(now) };
}

// Rate-Less Order Placement redesign: NO rate field on a new order line at
// all - Phase 1 only ever collects Ingredient + Quantity (see
// PurchaseOrderItemInput in pos-types.ts). The real rate is only entered
// once at Phase 2 (ReceivePurchaseOrderModal's billing screen, per line).
type NewOrderLine = { ingredientId: string; quantity: string };

// A Purchase Order is not its own backend collection - it's one or more
// IngredientPurchase line-item documents that share one purchaseOrderNumber
// (see ingredientPurchaseController.createPurchaseOrder). This is what
// turns the flat list fetchIngredientPurchases returns back into the
// grouped rows the Purchase Log actually displays.
function groupPurchasesByOrder(purchases: IngredientPurchase[], t: (key: string, vars?: Record<string, string | number>) => string): PurchaseOrderGroup[] {
  const byOrder = new Map<string, IngredientPurchase[]>();
  for (const purchase of purchases) {
    const key = purchase.purchaseOrderNumber;
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key)!.push(purchase);
  }
  return [...byOrder.entries()]
    .map(([purchaseOrderNumber, items]) => {
      const first = items[0];
      return {
        purchaseOrderNumber,
        companyName: first.companyName || t('purchase.unspecifiedCompany'),
        supplierId: first.supplierId,
        // Every line of one PO always shares the same status - see this
        // type's own comment in pos-types.ts.
        status: first.status,
        purchaseDate: first.purchaseDate,
        receivedAt: first.receivedAt,
        items,
        itemCount: items.length,
        totalQuantityLabel: items.map((item) => `${item.quantity}${item.unit}`).join(', '),
        totalAmount: items.reduce((sum, item) => sum + item.totalAmount, 0),
        paidAmount: items.reduce((sum, item) => sum + item.paidAmount, 0),
        remainingAmount: items.reduce((sum, item) => sum + item.remainingAmount, 0),
      };
    })
    .sort((a, b) => new Date(b.purchaseDate).getTime() - new Date(a.purchaseDate).getTime());
}

export default function PurchasePage() {
  const { toast } = useToast();
  const { t } = useLanguage();

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [purchases, setPurchases] = useState<IngredientPurchase[]>([]);
  const [companyLedger, setCompanyLedger] = useState<CompanyLedgerEntry[]>([]);
  const [monthSpend, setMonthSpend] = useState(0);
  const [loading, setLoading] = useState(true);

  const [preset, setPreset] = useState<Preset>('monthly');
  const initialRange = computePresetRange('monthly');
  const [rangeFrom, setRangeFrom] = useState(initialRange.from);
  const [rangeTo, setRangeTo] = useState(initialRange.to);
  const todayKey = toDateKey(new Date());

  const [statusTab, setStatusTab] = useState<'all' | 'pending' | 'received'>('all');
  const [activeSupplierId, setActiveSupplierId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [showNewOrder, setShowNewOrder] = useState(false);
  const [receiveTarget, setReceiveTarget] = useState<PurchaseOrderGroup | null>(null);
  // Bumped on every successful mutation (order created, order received) -
  // the active SupplierDashboard depends on this to know when to re-fetch
  // its own independently-filtered purchase history, since it doesn't share
  // the unified table's `purchases` state.
  const [dataVersion, setDataVersion] = useState(0);

  function applyPreset(next: Preset) {
    setPreset(next);
    const { from, to } = computePresetRange(next);
    setRangeFrom(from);
    setRangeTo(to);
  }

  async function loadDirectory() {
    try {
      const [sups, ings] = await Promise.all([fetchSuppliers(), fetchIngredients()]);
      if (sups) setSuppliers(sups);
      if (ings) setIngredients(ings);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.loadDirectoryFailed'));
    }
  }

  async function loadPurchases() {
    if (!rangeFrom || !rangeTo) return;
    setLoading(true);
    try {
      const data = await fetchIngredientPurchases({ startDate: rangeFrom, endDate: rangeTo });
      if (data) setPurchases(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.loadPurchasesFailed'));
    } finally {
      setLoading(false);
    }
  }

  // Monthly Spend + company dues stay independent of whatever range is
  // currently being browsed below - "this calendar month, received only"
  // and "every company's real balance right now", same all-time framing
  // fetchCompanyLedger's own backend already uses.
  async function loadSpendAndLedger() {
    try {
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const [monthPurchases, ledger] = await Promise.all([
        fetchIngredientPurchases({ status: 'received', startDate: toDateKey(first), endDate: toDateKey(now) }),
        fetchCompanyLedger(),
      ]);
      if (monthPurchases) setMonthSpend(monthPurchases.reduce((sum, p) => sum + p.totalAmount, 0));
      if (ledger) setCompanyLedger(ledger);
    } catch {
      // Decorative stats only - a failure here shouldn't block the page.
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadDirectory(); void loadSpendAndLedger(); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadPurchases(); }, [rangeFrom, rangeTo]);

  function refreshAfterMutation() {
    void loadPurchases();
    void loadSpendAndLedger();
    void loadDirectory(); // ingredients' currentStock changed after a receive
    setDataVersion((v) => v + 1);
  }

  const groupedOrders = useMemo(() => groupPurchasesByOrder(purchases, t), [purchases, t]);

  const activeSupplier = useMemo(
    () => suppliers.find((s) => s.id === activeSupplierId) || null,
    [suppliers, activeSupplierId],
  );

  // Suggested starting rate for each delivered line on the Phase 2 billing
  // screen - the ingredient's last-known moving-average cost, if any. Purely
  // a convenience default (staff can still edit it) - see openReceiveModal.
  const ingredientById = useMemo(() => new Map(ingredients.map((ing) => [ing.id, ing])), [ingredients]);

  // Centralized "All Orders" Master Export: grouped by Company Name, from
  // the FULL date-filtered set (groupedOrders) - deliberately ignoring the
  // status-tab/search filters just below, since a company-wide master log
  // should always cover both Pending and Completed orders across the active
  // date range, not whatever narrower on-screen slice is currently picked.
  const masterCompanyGroups = useMemo(() => {
    const byCompany = new Map<string, PurchaseOrderGroup[]>();
    for (const group of groupedOrders) {
      const key = group.companyName || t('purchase.unspecifiedCompany');
      const list = byCompany.get(key);
      if (list) list.push(group);
      else byCompany.set(key, [group]);
    }
    return [...byCompany.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [groupedOrders, t]);

  const masterTotals = useMemo(() => ({
    purchased: groupedOrders.reduce((sum, g) => sum + g.totalAmount, 0),
    paid: groupedOrders.reduce((sum, g) => sum + g.paidAmount, 0),
    due: groupedOrders.reduce((sum, g) => sum + g.remainingAmount, 0),
  }), [groupedOrders]);

  const masterRangeLabel = rangeFrom === rangeTo ? formatDisplayDate(rangeFrom) : `${formatDisplayDate(rangeFrom)} - ${formatDisplayDate(rangeTo)}`;

  function buildMasterPdfDoc() {
    const restaurantName = getAuthShop()?.name || t('purchase.defaultShopName');
    const tables = masterCompanyGroups.map(([companyName, companyGroups]) => {
      const purchased = companyGroups.reduce((sum, g) => sum + g.totalAmount, 0);
      const paid = companyGroups.reduce((sum, g) => sum + g.paidAmount, 0);
      const due = companyGroups.reduce((sum, g) => sum + g.remainingAmount, 0);
      return {
        // Heading-Wise Multi-Company Data Structuring: each company gets
        // its own table title, rendered by ReportPdfDocument's TableBlock
        // as a bold section heading directly above its own sub-table -
        // this is what turns one pooled PDF into a clean per-company
        // breakdown instead of one giant undifferentiated list.
        title: companyName,
        columns: [
          { label: t('purchase.columns.poNumber'), width: 1 },
          { label: t('purchase.columns.dateTime'), width: 1.3 },
          { label: t('purchase.columns.item'), width: 2 },
          { label: t('purchase.columns.qty'), width: 0.8, align: 'right' as const },
          { label: t('common.status'), width: 0.9 },
          { label: t('purchase.columns.rate'), width: 0.9, align: 'right' as const },
          { label: t('common.total'), width: 0.9, align: 'right' as const },
          { label: t('purchase.columns.paid'), width: 0.9, align: 'right' as const },
          { label: t('purchase.columns.due'), width: 0.9, align: 'right' as const },
        ],
        rows: companyGroups.flatMap((g) => g.items.map((item) => [
          g.purchaseOrderNumber,
          formatPurchaseDateTime(item.status === 'received' && item.receivedAt ? item.receivedAt : g.purchaseDate),
          `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}`,
          `${item.quantity}${item.unit}`,
          item.status === 'received' ? t('purchase.status.received') : t('purchase.status.pending'),
          formatMoney(item.rate),
          formatMoney(item.totalAmount),
          formatMoney(item.paidAmount),
          formatMoney(item.remainingAmount),
        ])),
        footer: ['', '', '', '', t('purchase.totalsLabel'), '', formatMoney(purchased), formatMoney(paid), formatMoney(due)],
        emptyMessage: t('purchase.empty.noOrders'),
      };
    });

    const companiesLabel = masterCompanyGroups.length === 1
      ? t('purchase.companiesCountLabel.one', { count: masterCompanyGroups.length })
      : t('purchase.companiesCountLabel.other', { count: masterCompanyGroups.length });
    const ordersLabel = groupedOrders.length === 1
      ? t('purchase.ordersCountLabel.one', { count: groupedOrders.length })
      : t('purchase.ordersCountLabel.other', { count: groupedOrders.length });

    return (
      <ReportPdfDocument
        title={t('purchase.titles.masterPurchaseLogAllCompanies')}
        subtitle={t('purchase.masterExport.summaryWithRange', { companies: companiesLabel, orders: ordersLabel, range: masterRangeLabel })}
        stats={[
          { label: t('purchase.stats.shop'), value: restaurantName },
          { label: t('purchase.stats.totalPurchased'), value: formatMoney(masterTotals.purchased) },
          { label: t('purchase.stats.totalPaid'), value: formatMoney(masterTotals.paid) },
          { label: t('purchase.stats.totalDue'), value: formatMoney(masterTotals.due) },
        ]}
        tables={tables}
      />
    );
  }

  function downloadMasterPdf() {
    void downloadPdfDocument(buildMasterPdfDoc(), 'All_Companies_Master_Purchase_Log.pdf');
  }

  // Heading-Wise Multi-Company Data Structuring for Excel: unlike a
  // multi-sheet workbook, this stays ONE sheet - each company's name is its
  // own bold heading row directly above its own column-header + data rows,
  // with a bolded per-company TOTALS row and a blank spacer row before the
  // next company - "one unified document", read top to bottom, company by
  // company, exactly like the PDF's own per-company table sections.
  function buildMasterExcelSheet(): ExcelSheet {
    const columnCount = 9;
    function blankRow(): ExcelCell[] {
      return Array.from({ length: columnCount }, () => ({ value: '' }));
    }
    function headingRow(companyName: string): ExcelCell[] {
      const row: ExcelCell[] = [{ value: companyName, style: { bold: true, fontSize: 12, bg: 'EEF2FF', color: '312E81' } }];
      for (let i = 1; i < columnCount; i += 1) row.push({ value: '', style: { bg: 'EEF2FF' } });
      return row;
    }
    const columnHeaderRow: ExcelCell[] = [
      { value: t('purchase.columns.poNumber'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
      { value: t('purchase.columns.dateTime'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
      { value: t('purchase.columns.item'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
      { value: t('purchase.columns.qty'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
      { value: t('common.status'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
      { value: t('purchase.columns.rate'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
      { value: t('common.total'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
      { value: t('purchase.columns.paid'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
      { value: t('purchase.columns.due'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
    ];

    const rows: ExcelCell[][] = [
      buildRestaurantNameRow(columnCount, t),
      buildGeneratedAtRow(columnCount, t),
      [{ value: t('purchase.titles.masterPurchaseLogAllCompanies'), style: { bold: true, fontSize: 13 } }, ...Array.from({ length: columnCount - 1 }, () => ({ value: '' }))],
      [{ value: masterRangeLabel, style: { color: '6B7280', fontSize: 9 } }, ...Array.from({ length: columnCount - 1 }, () => ({ value: '' }))],
      blankRow(),
    ];

    for (const [companyName, companyGroups] of masterCompanyGroups) {
      const purchased = companyGroups.reduce((sum, g) => sum + g.totalAmount, 0);
      const paid = companyGroups.reduce((sum, g) => sum + g.paidAmount, 0);
      const due = companyGroups.reduce((sum, g) => sum + g.remainingAmount, 0);

      rows.push(headingRow(companyName));
      rows.push(columnHeaderRow);
      for (const g of companyGroups) {
        for (const item of g.items) {
          rows.push([
            { value: g.purchaseOrderNumber },
            { value: formatPurchaseDateTime(item.status === 'received' && item.receivedAt ? item.receivedAt : g.purchaseDate) },
            { value: `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}` },
            { value: `${item.quantity}${item.unit}`, style: { align: 'Right' as const } },
            { value: item.status === 'received' ? t('purchase.status.received') : t('purchase.status.pending') },
            { value: item.rate, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
            { value: item.totalAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
            { value: item.paidAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
            { value: item.remainingAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          ]);
        }
      }
      rows.push([
        { value: '' }, { value: '' }, { value: '' }, { value: '' },
        { value: t('purchase.totalsLabel'), style: { bold: true } },
        { value: '' },
        { value: purchased, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
        { value: paid, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
        { value: due, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
      ]);
      rows.push(blankRow());
    }

    return { name: t('purchase.sheetNames.masterPurchaseLog'), columnWidths: [90, 130, 200, 70, 80, 80, 90, 80, 80], rows };
  }

  function downloadMasterExcel() {
    downloadExcelWorkbook([buildMasterExcelSheet()], 'All_Companies_Master_Purchase_Log.xls');
  }

  const filteredOrders = useMemo(() => {
    const query = search.trim().toLowerCase();
    return groupedOrders.filter((group) => {
      if (statusTab !== 'all' && group.status !== statusTab) return false;
      if (activeSupplierId && group.supplierId !== activeSupplierId) return false;
      // purchaseOrderNumber/companyName can be missing on a purchase order
      // created before those fields existed (see the PO-number and
      // companyName features) - calling .toLowerCase() straight on either
      // was crashing the whole app the instant a search query matched (or
      // even just existed alongside) one of those legacy records.
      if (query && !(group.purchaseOrderNumber || '').toLowerCase().includes(query) && !(group.companyName || '').toLowerCase().includes(query)) return false;
      return true;
    });
  }, [groupedOrders, statusTab, activeSupplierId, search]);

  const activePOCount = useMemo(() => groupedOrders.filter((g) => g.status === 'pending').length, [groupedOrders]);

  // Low Stock Warning: same isLow formula IngredientStockSection.tsx's own
  // ingredient list already uses - kept identical so the two pages never
  // disagree about which ingredients count as "low".
  const lowStockIngredients = useMemo(
    () => ingredients.filter((i) => i.lowStockThreshold > 0 && i.currentStock < i.lowStockThreshold),
    [ingredients],
  );

  const dueByCompanyName = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of companyLedger) map.set(row.companyName.trim().toLowerCase(), row.totalDue);
    return map;
  }, [companyLedger]);

  function resetFilters() {
    setSearch('');
    setStatusTab('all');
    setActiveSupplierId(null);
  }

  function toggleSupplierFilter(supplierId: string) {
    setActiveSupplierId((prev) => (prev === supplierId ? null : supplierId));
  }

  // --- New Purchase Order modal state ---
  const [orderSupplierId, setOrderSupplierId] = useState('');
  const [orderPurchaseDate, setOrderPurchaseDate] = useState(todayKey);
  const [orderNote, setOrderNote] = useState('');
  const [orderItems, setOrderItems] = useState<NewOrderLine[]>([{ ingredientId: '', quantity: '' }]);
  const [showNewSupplierForm, setShowNewSupplierForm] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState('');
  const [newSupplierPhone, setNewSupplierPhone] = useState('');
  const [submittingOrder, setSubmittingOrder] = useState(false);

  function openNewOrderModal(prefill?: NewOrderLine[]) {
    setOrderSupplierId('');
    setOrderPurchaseDate(toDateKey(new Date()));
    setOrderNote('');
    setOrderItems(prefill && prefill.length > 0 ? prefill : [{ ingredientId: '', quantity: '' }]);
    setShowNewSupplierForm(false);
    setNewSupplierName('');
    setNewSupplierPhone('');
    setShowNewOrder(true);
  }

  function updateOrderLine(index: number, patch: Partial<NewOrderLine>) {
    setOrderItems((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }
  function addOrderLine() {
    setOrderItems((prev) => [...prev, { ingredientId: '', quantity: '' }]);
  }
  function removeOrderLine(index: number) {
    setOrderItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  // Auto-Generate PO: the Low Stock Warning banner's button pre-fills a new
  // order with every currently-low ingredient, suggested quantity being
  // just enough to clear the safety threshold (staff can still edit
  // everything before submitting) - a real shortcut, not a decoration. No
  // rate suggestion here anymore - Rate-Less Order Placement means Phase 1
  // never asks for one.
  function handleAutoGeneratePO() {
    if (lowStockIngredients.length === 0) return;
    openNewOrderModal(
      lowStockIngredients.map((ing) => ({
        ingredientId: ing.id,
        quantity: String(Math.max(Number((ing.lowStockThreshold - ing.currentStock).toFixed(3)), 1)),
      })),
    );
  }

  async function handleQuickAddSupplier() {
    if (!newSupplierName.trim()) return;
    try {
      const created = await createSupplier({ name: newSupplierName.trim(), phone: newSupplierPhone.trim() });
      if (created) {
        setSuppliers((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        setOrderSupplierId(created.id);
        setShowNewSupplierForm(false);
        setNewSupplierName('');
        setNewSupplierPhone('');
        toast.success(t('purchase.toast.supplierAdded', { name: created.name }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.addSupplierFailed'));
    }
  }

  async function submitNewOrder() {
    const supplier = suppliers.find((s) => s.id === orderSupplierId);
    if (!supplier) {
      toast.error(t('purchase.toast.selectSupplierFirst'));
      return;
    }
    const validItems = orderItems
      .filter((line) => line.ingredientId && Number(line.quantity) > 0)
      .map((line) => ({ ingredientId: line.ingredientId, quantity: Number(line.quantity) }));
    if (validItems.length === 0) {
      toast.error(t('purchase.toast.addAtLeastOneItem'));
      return;
    }
    setSubmittingOrder(true);
    try {
      const result = await createPurchaseOrder({
        companyName: supplier.name,
        supplierId: supplier.id,
        purchaseDate: orderPurchaseDate,
        note: orderNote.trim() || undefined,
        items: validItems,
      });
      if (result) {
        const itemsLabel = validItems.length === 1
          ? t('purchase.itemCountLabel.one', { count: validItems.length })
          : t('purchase.itemCountLabel.other', { count: validItems.length });
        toast.success(t('purchase.toast.orderCreated', { po: result.purchaseOrderNumber, items: itemsLabel }));
        setShowNewOrder(false);
        refreshAfterMutation();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.createOrderFailed'));
    } finally {
      setSubmittingOrder(false);
    }
  }

  // --- Receive Purchase Order modal state (Phase 2: the real billing
  // screen - a rate is entered per delivered line HERE, since Phase 1 never
  // collected one) ---
  const [receiveLineRates, setReceiveLineRates] = useState<Record<string, string>>({});
  const [receivePaymentType, setReceivePaymentType] = useState<'full' | 'partial'>('full');
  const [receivePartialAmount, setReceivePartialAmount] = useState('');
  const [submittingReceive, setSubmittingReceive] = useState(false);

  function openReceiveModal(group: PurchaseOrderGroup) {
    setReceiveTarget(group);
    setReceivePaymentType('full');
    setReceivePartialAmount('');
    // Suggest each line's last-known moving-average cost as a starting rate
    // - purely a convenience default, staff can edit every figure before
    // confirming; never trusted as-is.
    const defaults: Record<string, string> = {};
    for (const item of group.items) {
      const ingredient = ingredientById.get(item.ingredientId);
      defaults[item.id] = ingredient && ingredient.averageCost > 0 ? String(ingredient.averageCost) : '';
    }
    setReceiveLineRates(defaults);
  }

  function setReceiveLineRate(itemId: string, value: string) {
    setReceiveLineRates((prev) => ({ ...prev, [itemId]: value }));
  }

  // Total Bill: the first moment any price has ever existed on this order -
  // computed fresh from qty * each line's just-entered rate, live as the
  // manager types (see ingredientPurchaseController.receivePurchaseOrder's
  // own comment - the backend recomputes this exact same way, never trusts
  // a client-sent total).
  const receiveTotalBill = useMemo(() => {
    if (!receiveTarget) return 0;
    return receiveTarget.items.reduce((sum, item) => sum + (Number(receiveLineRates[item.id]) || 0) * item.quantity, 0);
  }, [receiveTarget, receiveLineRates]);

  const receiveAmount = receiveTarget
    ? receivePaymentType === 'full'
      ? receiveTotalBill
      : Math.min(Math.max(Number(receivePartialAmount) || 0, 0), receiveTotalBill)
    : 0;
  const receiveDue = receiveTarget ? Math.max(receiveTotalBill - receiveAmount, 0) : 0;

  async function submitReceive() {
    if (!receiveTarget) return;
    const items: PurchaseOrderReceiveItemInput[] = [];
    for (const item of receiveTarget.items) {
      const rawRate = receiveLineRates[item.id];
      const rateValue = Number(rawRate);
      if (rawRate === undefined || rawRate === '' || !Number.isFinite(rateValue) || rateValue < 0) {
        toast.error(t('purchase.toast.invalidRate', { name: item.ingredientName }));
        return;
      }
      items.push({ purchaseId: item.id, rate: rateValue });
    }
    setSubmittingReceive(true);
    try {
      const result = await receivePurchaseOrder(receiveTarget.purchaseOrderNumber, items, receiveAmount);
      if (result) {
        const suffix = receiveDue > 0
          ? t('purchase.toast.dueSuffix', { amount: Math.round(receiveDue) })
          : t('purchase.toast.paidInFullSuffix');
        toast.success(t('purchase.toast.receivedSuccess', { po: receiveTarget.purchaseOrderNumber, suffix }));
        setReceiveTarget(null);
        refreshAfterMutation();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.receiveFailed'));
    } finally {
      setSubmittingReceive(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F1F5F9] p-4 lg:p-8 space-y-8">

      {/* Header & Main Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3">
            {t('purchase.header.title')} <Truck className="text-indigo-600" size={32} />
          </h1>
          <p className="text-slate-500 font-bold">{t('purchase.header.subtitle')}</p>
        </div>

        <div className="flex flex-wrap gap-3">
          {/* Was `hidden xl:block` - only appeared once the window hit
              1280px wide, which invisibly hid the search box on any normal
              (non-maximized-ultrawide) desktop window size. Always visible
              now, full width on a narrow window and a fixed 256px once
              there's room (sm, 640px) - same breathing-room breakpoint used
              elsewhere in the app, not the near-unreachable xl one. */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-4 rtl:left-auto rtl:right-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('purchase.searchPlaceholder')}
              className="w-full pl-12 pr-4 rtl:pl-4 rtl:pr-12 py-3 bg-white border-none rounded-2xl shadow-sm focus:ring-2 focus:ring-indigo-500 text-sm outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => openNewOrderModal()}
            className="flex items-center gap-2 px-6 py-4 border-[0.5px] border-white/30 bg-indigo-600 text-white rounded-[20px] font-black text-sm hover:bg-indigo-700 transition-all shadow-[inset_0_1px_0_rgba(255,255,255,0.3),inset_0_-3px_7px_rgba(49,46,129,0.5)]"
          >
            <PackagePlus size={18} /> {t('purchase.newPurchaseOrder')}
          </button>
        </div>
      </div>

      {/* Critical Stock Alerts - real count, real action */}
      {lowStockIngredients.length > 0 ? (
        <div className="bg-orange-50 border border-orange-100 p-6 rounded-[32px] flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-orange-500 text-white rounded-2xl animate-pulse">
              <AlertCircle size={24} />
            </div>
            <div>
              <h4 className="font-black text-orange-900">{t('purchase.lowStock.title')}</h4>
              <p className="text-orange-700 text-sm font-medium">
                {lowStockIngredients.length === 1
                  ? t('purchase.lowStock.messageOne', { count: lowStockIngredients.length })
                  : t('purchase.lowStock.messageOther', { count: lowStockIngredients.length })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleAutoGeneratePO}
            className="px-6 py-2 bg-orange-500 text-white rounded-xl text-xs font-black uppercase tracking-widest hover:bg-orange-600 transition-colors"
          >
            {t('purchase.lowStock.autoGenerate')}
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">

        {/* Sidebar: Supplier Quick Access */}
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-[32px] shadow-sm border border-slate-200">
            <h3 className="font-black text-slate-900 mb-4 flex items-center justify-between">
              {t('purchase.sidebar.suppliersTitle')}
              {activeSupplierId ? (
                <button type="button" onClick={() => setActiveSupplierId(null)} className="text-[10px] font-black text-indigo-500 uppercase">{t('common.clear')}</button>
              ) : (
                <span className="text-[10px] text-slate-300 uppercase">{t('purchase.sidebar.suppliersTotal', { count: suppliers.length })}</span>
              )}
            </h3>
            <div className="space-y-3">
              {suppliers.length === 0 ? (
                <p className="text-xs font-bold text-slate-400">{t('purchase.sidebar.noSuppliers', { action: t('purchase.newPurchaseOrder') })}</p>
              ) : (
                suppliers.map((sup) => {
                  const due = dueByCompanyName.get(sup.name.trim().toLowerCase()) || 0;
                  const isActive = activeSupplierId === sup.id;
                  return (
                    <div
                      key={sup.id}
                      onClick={() => toggleSupplierFilter(sup.id)}
                      className={`flex items-center justify-between p-3 rounded-2xl cursor-pointer transition-colors group ${isActive ? 'bg-indigo-50' : 'hover:bg-slate-50'}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-10 h-10 shrink-0 rounded-xl flex items-center justify-center font-black transition-colors ${isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-400 group-hover:bg-indigo-100 group-hover:text-indigo-600'}`}>
                          {sup.name[0]?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-slate-700">{sup.name}</p>
                          {due > 0 ? <p className="text-[10px] font-black text-rose-500">{t('purchase.sidebar.dueAmount', { amount: formatMoney(due) })}</p> : null}
                        </div>
                      </div>
                      <ChevronRight size={14} className="shrink-0 text-slate-300" />
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="bg-slate-900 p-8 rounded-[32px] text-white overflow-hidden relative">
            <Box className="absolute -right-4 -bottom-4 text-white/10" size={120} />
            <h4 className="text-xs font-black uppercase tracking-[0.2em] text-slate-500 mb-2">{t('purchase.sidebar.monthlySpend')}</h4>
            <div className="text-3xl font-black">{formatMoney(monthSpend)}</div>
            <button
              type="button"
              onClick={() => setStatusTab('pending')}
              className="text-[10px] text-indigo-400 font-bold mt-4 flex items-center gap-1"
            >
              {t('purchase.sidebar.activePOs', { count: activePOCount })} <ArrowRight size={10} className="rtl:rotate-180" />
            </button>
          </div>
        </div>

        {/* Main: Purchase Order List, or a selected Supplier's own Dual-Stream Dashboard */}
        <div className="lg:col-span-3 bg-white rounded-[40px] shadow-sm border border-slate-200 overflow-hidden">
          {activeSupplier ? (
            <SupplierDashboard
              supplier={activeSupplier}
              onBack={() => setActiveSupplierId(null)}
              onReceiveClick={openReceiveModal}
              dataVersion={dataVersion}
              toast={toast}
            />
          ) : (
          <>
          <div className="p-8 border-b border-slate-50 flex flex-col gap-4 lg:flex-row lg:items-center justify-between">
            <div className="flex gap-6">
              {(['all', 'pending', 'received'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setStatusTab(tab)}
                  className={`text-sm font-black transition-all relative pb-2 capitalize ${statusTab === tab ? 'text-indigo-600' : 'text-slate-400'}`}
                >
                  {tab === 'all' ? t('purchase.tabs.all') : tab === 'pending' ? t('purchase.tabs.pendingDispatched') : t('purchase.status.received')}
                  {statusTab === tab && <div className="absolute bottom-0 left-0 w-full h-1 bg-indigo-600 rounded-full" />}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <div className="flex bg-slate-50 p-1 rounded-2xl">
                {(['daily', 'monthly', 'custom'] as Preset[]).map((item) => (
                  <button
                    key={item}
                    onClick={() => applyPreset(item)}
                    className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wide transition-all capitalize ${
                      preset === item ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-600'
                    }`}
                  >
                    {t(`purchase.preset.${item}`)}
                  </button>
                ))}
              </div>
              {preset === 'custom' ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="date"
                    value={rangeFrom}
                    max={rangeTo || todayKey}
                    onChange={(e) => setRangeFrom(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold outline-none focus:border-indigo-400"
                  />
                  <span className="text-[10px] font-black text-slate-400">{t('purchase.rangeTo')}</span>
                  <input
                    type="date"
                    value={rangeTo}
                    min={rangeFrom}
                    max={todayKey}
                    onChange={(e) => setRangeTo(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold outline-none focus:border-indigo-400"
                  />
                </div>
              ) : null}
              <button type="button" onClick={resetFilters} title={t('purchase.resetFilters')} className="p-2 bg-slate-50 text-slate-400 rounded-xl hover:text-indigo-600 transition-colors">
                <Filter size={18} />
              </button>
            </div>
          </div>

          {/* Centralized "All Orders" Master Export - pooled across every
              company, dynamically scoped to whichever date preset/range is
              active above (Daily/Monthly/Custom), grouped company-by-company
              inside the exported document itself (see buildMasterPdfDoc/
              buildMasterExcelSheet). */}
          <div className="px-8 py-4 border-b border-slate-50 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between bg-slate-50/50">
            <div>
              <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.masterExport.heading')}</h4>
              <p className="text-[10px] font-bold text-slate-400">
                {t('purchase.masterExport.summary', {
                  companies: masterCompanyGroups.length === 1
                    ? t('purchase.companiesCountLabel.one', { count: masterCompanyGroups.length })
                    : t('purchase.companiesCountLabel.other', { count: masterCompanyGroups.length }),
                  orders: groupedOrders.length === 1
                    ? t('purchase.ordersCountLabel.one', { count: groupedOrders.length })
                    : t('purchase.ordersCountLabel.other', { count: groupedOrders.length }),
                })}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={downloadMasterPdf}
                disabled={groupedOrders.length === 0}
                className="flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-[10px] font-black uppercase tracking-wide text-white hover:bg-slate-800 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download size={14} /> {t('purchase.masterExport.downloadPdf')}
              </button>
              <button
                type="button"
                onClick={downloadMasterExcel}
                disabled={groupedOrders.length === 0}
                className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-4 py-2.5 text-[10px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-200 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FileSpreadsheet size={14} /> {t('purchase.masterExport.downloadExcel')}
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left rtl:text-right">
              <thead>
                <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
                  <th className="px-8 py-6 text-left rtl:text-right">{t('purchase.table.orderInfo')}</th>
                  <th className="px-8 py-6 text-left rtl:text-right">{t('purchase.table.supplier')}</th>
                  <th className="px-8 py-6 text-left rtl:text-right">{t('purchase.table.items')}</th>
                  <th className="px-8 py-6 text-left rtl:text-right">{t('common.status')}</th>
                  <th className="px-8 py-6 text-right rtl:text-left">{t('purchase.table.totalCost')}</th>
                  <th className="px-8 py-6 text-right rtl:text-left">{t('purchase.table.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {loading ? (
                  <tr><td colSpan={6} className="px-8 py-10 text-center text-sm font-bold text-slate-400 animate-pulse">{t('purchase.table.loading')}</td></tr>
                ) : filteredOrders.length === 0 ? (
                  <tr><td colSpan={6} className="px-8 py-10 text-center text-sm font-bold text-slate-400">{t('purchase.table.noMatches')}</td></tr>
                ) : (
                  filteredOrders.map((po) => (
                    <tr key={po.purchaseOrderNumber} className="group hover:bg-slate-50/50 transition-colors">
                      <td className="px-8 py-6">
                        <div className="flex items-center gap-4">
                          <div className={`w-2 h-2 rounded-full ${po.status === 'received' ? 'bg-emerald-500' : 'bg-indigo-500'}`} />
                          <div>
                            <div className="text-sm font-black text-slate-900">{po.purchaseOrderNumber}</div>
                            <div className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{formatDisplayDate(po.purchaseDate)}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-6">
                        <span className="text-sm font-bold text-slate-600">{po.companyName}</span>
                      </td>
                      <td className="px-8 py-6">
                        <span className="text-sm font-black text-slate-900">
                          {po.itemCount === 1
                            ? t('purchase.itemCountLabel.one', { count: po.itemCount })
                            : t('purchase.itemCountLabel.other', { count: po.itemCount })}
                        </span>
                        <p className="text-[10px] font-bold text-slate-400 truncate max-w-[160px]">{po.totalQuantityLabel}</p>
                      </td>
                      <td className="px-8 py-6">
                        <span className={`flex items-center gap-1.5 text-[10px] font-black uppercase px-3 py-1.5 rounded-lg w-fit ${
                          po.status === 'received' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'
                        }`}>
                          {po.status === 'received' ? <CheckCircle2 size={12} /> : <Clock size={12} />}
                          {po.status === 'received' ? t('purchase.status.received') : t('purchase.tabs.pendingDispatched')}
                        </span>
                      </td>
                      <td className="px-8 py-6 text-right rtl:text-left">
                        <div className="text-sm font-black text-slate-900">{formatMoney(po.totalAmount)}</div>
                        {po.status === 'received' && po.remainingAmount > 0 ? (
                          <div className="text-[10px] font-bold text-rose-500 uppercase">{t('purchase.sidebar.dueAmount', { amount: formatMoney(po.remainingAmount) })}</div>
                        ) : (
                          <div className="text-[10px] font-bold text-indigo-500 uppercase">{po.status === 'received' ? t('purchase.status.paidInFull') : t('purchase.status.awaitingDelivery')}</div>
                        )}
                      </td>
                      <td className="px-8 py-6 text-right rtl:text-left">
                        {po.status === 'pending' ? (
                          <button
                            type="button"
                            onClick={() => openReceiveModal(po)}
                            className="rounded-xl bg-emerald-500 px-4 py-2 text-[10px] font-black uppercase tracking-wide text-white hover:bg-emerald-600 transition-colors"
                          >
                            {t('purchase.table.markReceived')}
                          </button>
                        ) : (
                          <span className="text-[10px] font-bold text-slate-300">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          </>
          )}
        </div>

      </div>

      {showNewOrder ? (
        <NewPurchaseOrderModal
          suppliers={suppliers}
          ingredients={ingredients}
          orderSupplierId={orderSupplierId}
          setOrderSupplierId={setOrderSupplierId}
          orderPurchaseDate={orderPurchaseDate}
          setOrderPurchaseDate={setOrderPurchaseDate}
          orderNote={orderNote}
          setOrderNote={setOrderNote}
          orderItems={orderItems}
          updateLine={updateOrderLine}
          addLine={addOrderLine}
          removeLine={removeOrderLine}
          showNewSupplierForm={showNewSupplierForm}
          setShowNewSupplierForm={setShowNewSupplierForm}
          newSupplierName={newSupplierName}
          setNewSupplierName={setNewSupplierName}
          newSupplierPhone={newSupplierPhone}
          setNewSupplierPhone={setNewSupplierPhone}
          onQuickAddSupplier={() => void handleQuickAddSupplier()}
          onSubmit={() => void submitNewOrder()}
          onClose={() => setShowNewOrder(false)}
          submitting={submittingOrder}
          todayKey={todayKey}
        />
      ) : null}

      {receiveTarget ? (
        <ReceivePurchaseOrderModal
          group={receiveTarget}
          lineRates={receiveLineRates}
          setLineRate={setReceiveLineRate}
          paymentType={receivePaymentType}
          setPaymentType={setReceivePaymentType}
          partialAmount={receivePartialAmount}
          setPartialAmount={setReceivePartialAmount}
          totalBill={receiveTotalBill}
          amount={receiveAmount}
          due={receiveDue}
          onSubmit={() => void submitReceive()}
          onClose={() => setReceiveTarget(null)}
          submitting={submittingReceive}
        />
      ) : null}
    </div>
  );
}

// --- New Purchase Order modal ---

function NewPurchaseOrderModal({
  suppliers, ingredients, orderSupplierId, setOrderSupplierId,
  orderPurchaseDate, setOrderPurchaseDate, orderNote, setOrderNote,
  orderItems, updateLine, addLine, removeLine,
  showNewSupplierForm, setShowNewSupplierForm,
  newSupplierName, setNewSupplierName, newSupplierPhone, setNewSupplierPhone,
  onQuickAddSupplier, onSubmit, onClose, submitting, todayKey,
}: {
  suppliers: Supplier[];
  ingredients: Ingredient[];
  orderSupplierId: string;
  setOrderSupplierId: (value: string) => void;
  orderPurchaseDate: string;
  setOrderPurchaseDate: (value: string) => void;
  orderNote: string;
  setOrderNote: (value: string) => void;
  orderItems: NewOrderLine[];
  updateLine: (index: number, patch: Partial<NewOrderLine>) => void;
  addLine: () => void;
  removeLine: (index: number) => void;
  showNewSupplierForm: boolean;
  setShowNewSupplierForm: (value: boolean | ((prev: boolean) => boolean)) => void;
  newSupplierName: string;
  setNewSupplierName: (value: string) => void;
  newSupplierPhone: string;
  setNewSupplierPhone: (value: string) => void;
  onQuickAddSupplier: () => void;
  onSubmit: () => void;
  onClose: () => void;
  submitting: boolean;
  todayKey: string;
}) {
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);
  const { t } = useLanguage();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-2xl max-h-[calc(100vh-2rem)] flex-col rounded-[32px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-xl font-black text-slate-900">{t('purchase.newPurchaseOrder')}</h2>
            <p className="text-xs font-bold text-slate-400">{t('purchase.newOrderModal.subtitle')}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.newOrderModal.supplierCompanyLabel')}</label>
            <div className="flex gap-2">
              <select
                value={orderSupplierId}
                onChange={(e) => setOrderSupplierId(e.target.value)}
                className="flex-1 min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-bold outline-none focus:border-indigo-400"
              >
                <option value="">{suppliers.length === 0 ? t('purchase.newOrderModal.noCompaniesOption') : t('purchase.newOrderModal.selectSupplierOption')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <button type="button" onClick={() => setShowNewSupplierForm((prev) => !prev)} className="shrink-0 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-black text-white">
                {t('purchase.newOrderModal.newSupplierButton')}
              </button>
            </div>
            {showNewSupplierForm ? (
              <div className="mt-2 flex gap-2 rounded-xl bg-slate-50 p-3">
                <input
                  value={newSupplierName}
                  onChange={(e) => setNewSupplierName(e.target.value)}
                  placeholder={t('purchase.newOrderModal.companyNamePlaceholder')}
                  className="flex-1 min-w-0 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                />
                <input
                  value={newSupplierPhone}
                  onChange={(e) => setNewSupplierPhone(e.target.value)}
                  placeholder={t('purchase.newOrderModal.phonePlaceholder')}
                  className="w-36 shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
                />
                <button type="button" onClick={onQuickAddSupplier} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-black text-white">
                  {t('common.add')}
                </button>
              </div>
            ) : null}
          </div>

          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.newOrderModal.orderDateLabel')}</label>
            <input
              type="date"
              value={orderPurchaseDate}
              max={todayKey}
              onChange={(e) => setOrderPurchaseDate(e.target.value)}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-bold outline-none focus:border-indigo-400"
            />
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.table.items')}</label>
              <button type="button" onClick={addLine} className="flex items-center gap-1 text-xs font-black text-indigo-600">
                <Plus size={14} /> {t('purchase.newOrderModal.addItem')}
              </button>
            </div>
            <p className="mb-2 text-[10px] font-bold text-slate-400">{t('purchase.newOrderModal.itemsHint')}</p>
            <div className="space-y-2">
              {orderItems.map((line, idx) => (
                <div key={idx} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                  <select
                    value={line.ingredientId}
                    onChange={(e) => updateLine(idx, { ingredientId: e.target.value })}
                    className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-2 text-xs font-bold outline-none focus:border-indigo-400"
                  >
                    <option value="">{t('purchase.newOrderModal.selectIngredientOption')}</option>
                    {ingredients.map((ing) => (
                      <option key={ing.id} value={ing.id}>{ing.name} ({ing.unit})</option>
                    ))}
                  </select>
                  <input
                    value={line.quantity}
                    onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) updateLine(idx, { quantity: e.target.value }); }}
                    placeholder={t('purchase.columns.qty')}
                    className="w-20 shrink-0 rounded-lg border border-slate-200 px-2 py-2 text-xs font-bold outline-none focus:border-indigo-400"
                  />
                  <button type="button" onClick={() => removeLine(idx)} className="shrink-0 text-slate-300 hover:text-rose-500">
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.newOrderModal.noteLabel')}</label>
            <textarea
              value={orderNote}
              onChange={(e) => setOrderNote(e.target.value)}
              rows={2}
              className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
            />
          </div>
        </div>

        <div className="shrink-0 border-t border-slate-100 p-6">
          <button
            type="button"
            disabled={submitting}
            onClick={onSubmit}
            className="w-full rounded-2xl bg-indigo-600 py-3.5 text-sm font-black text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? t('purchase.newOrderModal.creating') : t('purchase.newOrderModal.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Receive Purchase Order modal ---

// Phase 2 (Delivery Fulfillment & Billing) redesign: this modal IS the
// billing screen now - no rate ever existed on this order before this
// moment (Phase 1 is rate-less), so every delivered line gets its Actual
// Supplier Rate entered right here, with the Total Bill computed live as
// the manager types. Only once every line has a rate can Full/Partial
// payment be decided against that freshly-computed total.
function ReceivePurchaseOrderModal({
  group, lineRates, setLineRate, paymentType, setPaymentType, partialAmount, setPartialAmount,
  totalBill, amount, due, onSubmit, onClose, submitting,
}: {
  group: PurchaseOrderGroup;
  lineRates: Record<string, string>;
  setLineRate: (itemId: string, value: string) => void;
  paymentType: 'full' | 'partial';
  setPaymentType: (value: 'full' | 'partial') => void;
  partialAmount: string;
  setPartialAmount: (value: string) => void;
  totalBill: number;
  amount: number;
  due: number;
  onSubmit: () => void;
  onClose: () => void;
  submitting: boolean;
}) {
  // Universal Popup-Close Hotkey - see useBackspaceToClose's own comment.
  useBackspaceToClose(onClose);
  const { t } = useLanguage();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-2xl max-h-[calc(100vh-2rem)] flex-col rounded-[32px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-black text-slate-900">{t('purchase.receiveModal.title', { po: group.purchaseOrderNumber })}</h2>
            <p className="text-xs font-bold text-slate-400">{t('purchase.receiveModal.subtitle', { company: group.companyName })}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full bg-slate-50 p-2.5 text-slate-400 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="space-y-2">
            {group.items.map((item) => {
              const rateValue = lineRates[item.id] ?? '';
              const lineTotal = (Number(rateValue) || 0) * item.quantity;
              return (
                <div key={item.id} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-bold text-slate-700">
                      {item.ingredientName}{item.productDetails ? ` · ${item.productDetails}` : ''}
                    </p>
                    <p className="text-[10px] font-black text-slate-400 uppercase">{item.quantity}{item.unit}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="text-[10px] font-black text-slate-400">{t('purchase.columns.rate')}</span>
                    <input
                      value={rateValue}
                      onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setLineRate(item.id, e.target.value); }}
                      placeholder="0"
                      className="w-20 rounded-lg border border-slate-200 px-2 py-2 text-xs font-bold text-right outline-none focus:border-indigo-400"
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs font-black text-slate-900">{formatMoney(lineTotal)}</span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between rounded-2xl bg-slate-900 px-5 py-3.5 text-white">
            <span className="text-xs font-black uppercase tracking-wide text-slate-400">{t('purchase.receiveModal.totalBill')}</span>
            <span className="text-xl font-black">{formatMoney(totalBill)}</span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPaymentType('full')}
              className={`rounded-xl py-2.5 text-xs font-black uppercase transition-colors ${paymentType === 'full' ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-500'}`}
            >
              {t('purchase.receiveModal.fullPay')}
            </button>
            <button
              type="button"
              onClick={() => setPaymentType('partial')}
              className={`rounded-xl py-2.5 text-xs font-black uppercase transition-colors ${paymentType === 'partial' ? 'bg-amber-500 text-white' : 'bg-slate-100 text-slate-500'}`}
            >
              {t('purchase.receiveModal.partialDues')}
            </button>
          </div>

          {paymentType === 'partial' ? (
            <div>
              <label className="mb-1 block text-xs font-black uppercase tracking-wide text-slate-500">{t('purchase.receiveModal.amountPaidNowLabel')}</label>
              <input
                value={partialAmount}
                onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setPartialAmount(e.target.value); }}
                placeholder={t('purchase.receiveModal.upToPlaceholder', { amount: Math.round(totalBill) })}
                className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold outline-none focus:border-indigo-400"
              />
            </div>
          ) : null}

          {due > 0 ? (
            <div className="rounded-2xl bg-rose-50 px-4 py-3 text-center">
              <p className="text-[10px] font-black uppercase tracking-wide text-rose-500">{t('purchase.receiveModal.remainingDue')}</p>
              <p className="text-2xl font-black text-rose-600">{formatMoney(due)}</p>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 border-t border-slate-100 p-6">
          <button
            type="button"
            disabled={submitting}
            onClick={onSubmit}
            className="w-full rounded-2xl bg-indigo-600 py-3.5 text-sm font-black text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? t('purchase.receiveModal.receiving') : t('purchase.receiveModal.confirmSubmit')}
          </button>
          <p className="mt-2 text-center text-[10px] font-bold text-slate-400">
            {t('purchase.receiveModal.amountToRecord', { amount: formatMoney(amount) })}
          </p>
        </div>
      </div>
    </div>
  );
}

// --- Per-Supplier Dashboard (Request B): Pending vs Completed dual-stream
// tracking, its own independent Daily/Monthly/Custom date filter, and
// PDF/Excel/WhatsApp exports scoped to whichever stream is active - Pending
// exports a rate-less demand sheet (nothing has been priced yet), Completed
// exports a full financial statement. Fetches its own purchase history
// (scoped server-side by supplierId - see ingredientPurchaseController.
// getPurchases) independent of the unified Purchase Log's own date range,
// since a supplier's own dashboard should be browsable on its own timeline.
function SupplierDashboard({
  supplier, onBack, onReceiveClick, dataVersion, toast,
}: {
  supplier: Supplier;
  onBack: () => void;
  onReceiveClick: (group: PurchaseOrderGroup) => void;
  dataVersion: number;
  toast: ReturnType<typeof useToast>['toast'];
}) {
  const [preset, setPreset] = useState<Preset>('monthly');
  const [rangeFrom, setRangeFrom] = useState(() => computePresetRange('monthly').from);
  const [rangeTo, setRangeTo] = useState(() => computePresetRange('monthly').to);
  const todayKey = toDateKey(new Date());
  const [stream, setStream] = useState<'pending' | 'completed'>('pending');
  const [purchases, setPurchases] = useState<IngredientPurchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingWhatsapp, setSendingWhatsapp] = useState(false);
  const { t } = useLanguage();

  function applyPreset(next: Preset) {
    setPreset(next);
    const { from, to } = computePresetRange(next);
    setRangeFrom(from);
    setRangeTo(to);
  }

  async function load() {
    if (!rangeFrom || !rangeTo) return;
    setLoading(true);
    try {
      const data = await fetchIngredientPurchases({ supplierId: supplier.id, startDate: rangeFrom, endDate: rangeTo });
      if (data) setPurchases(data);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.loadSupplierHistoryFailed'));
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [supplier.id, rangeFrom, rangeTo, dataVersion]);

  const groups = useMemo(() => groupPurchasesByOrder(purchases, t), [purchases, t]);
  const pendingGroups = useMemo(() => groups.filter((g) => g.status === 'pending'), [groups]);
  const completedGroups = useMemo(() => groups.filter((g) => g.status === 'received'), [groups]);
  const activeGroups = stream === 'pending' ? pendingGroups : completedGroups;

  const completedTotals = useMemo(() => ({
    purchased: completedGroups.reduce((sum, g) => sum + g.totalAmount, 0),
    paid: completedGroups.reduce((sum, g) => sum + g.paidAmount, 0),
    due: completedGroups.reduce((sum, g) => sum + g.remainingAmount, 0),
  }), [completedGroups]);

  const rangeLabel = rangeFrom === rangeTo ? formatDisplayDate(rangeFrom) : `${formatDisplayDate(rangeFrom)} - ${formatDisplayDate(rangeTo)}`;

  // --- Pending: rate-less demand sheet (nothing has been priced yet) ---
  function buildPendingPdfDoc() {
    const restaurantName = getAuthShop()?.name || t('purchase.defaultShopName');
    const pendingLabel = pendingGroups.length === 1
      ? t('purchase.pendingOrdersCountLabel.one', { count: pendingGroups.length })
      : t('purchase.pendingOrdersCountLabel.other', { count: pendingGroups.length });
    return (
      <ReportPdfDocument
        title={t('purchase.titles.demandSheetDoc', { name: supplier.name })}
        subtitle={t('purchase.subtitleWithRange', { count: pendingLabel, range: rangeLabel })}
        stats={[
          { label: t('purchase.stats.shop'), value: restaurantName },
          { label: t('purchase.stats.pendingOrders'), value: String(pendingGroups.length) },
          { label: t('purchase.stats.lineItems'), value: String(pendingGroups.reduce((sum, g) => sum + g.itemCount, 0)) },
        ]}
        tables={[{
          title: t('purchase.titles.demandRequirementSheet'),
          columns: [
            { label: t('purchase.columns.poNumber'), width: 1 },
            { label: t('purchase.columns.dateTime'), width: 1.3 },
            { label: t('purchase.columns.item'), width: 2.2 },
            { label: t('purchase.columns.quantity'), width: 1, align: 'right' },
          ],
          rows: pendingGroups.flatMap((g) => g.items.map((item) => [
            g.purchaseOrderNumber,
            formatPurchaseDateTime(g.purchaseDate),
            `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}`,
            `${item.quantity}${item.unit}`,
          ])),
          emptyMessage: t('purchase.empty.noPendingOrders'),
        }]}
      />
    );
  }

  function downloadPendingPdf() {
    void downloadPdfDocument(buildPendingPdfDoc(), `${supplier.name.replace(/\s+/g, '_')}_demand_sheet.pdf`);
  }

  function buildPendingExcelSheet(): ExcelSheet {
    return {
      name: t('purchase.sheetNames.demandSheet'),
      columnWidths: [90, 130, 220, 90],
      rows: [
        buildRestaurantNameRow(4, t),
        buildGeneratedAtRow(4, t),
        [
          { value: t('purchase.columns.poNumber'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.dateTime'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.item'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.quantity'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
        ],
        ...pendingGroups.flatMap((g) => g.items.map((item) => [
          { value: g.purchaseOrderNumber },
          { value: formatPurchaseDateTime(g.purchaseDate) },
          { value: `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}` },
          { value: `${item.quantity}${item.unit}`, style: { align: 'Right' as const } },
        ])),
      ],
    };
  }

  function downloadPendingExcel() {
    downloadExcelWorkbook([buildPendingExcelSheet()], `${supplier.name.replace(/\s+/g, '_')}_demand_sheet.xls`);
  }

  async function sendPendingWhatsapp() {
    if (!supplier.phone.trim()) {
      toast.error(t('purchase.toast.noWhatsappNumber', { name: supplier.name }));
      return;
    }
    try {
      setSendingWhatsapp(true);
      const base64 = await pdfDocumentToBase64(buildPendingPdfDoc());
      await sendWhatsappDocument(supplier.phone, base64, `${supplier.name.replace(/\s+/g, '_')}_demand_sheet.pdf`);
      toast.success(t('purchase.toast.demandSheetSent', { name: supplier.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.whatsappSendFailed'));
    } finally {
      setSendingWhatsapp(false);
    }
  }

  // --- Completed: full financial statement ---
  function buildCompletedRows() {
    return completedGroups.flatMap((g) => g.items.map((item) => [
      g.purchaseOrderNumber,
      formatPurchaseDateTime(item.receivedAt || g.purchaseDate),
      `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}`,
      `${item.quantity}${item.unit}`,
      formatMoney(item.rate),
      formatMoney(item.totalAmount),
      formatMoney(item.paidAmount),
      formatMoney(item.remainingAmount),
    ]));
  }

  function buildCompletedPdfDoc() {
    const restaurantName = getAuthShop()?.name || t('purchase.defaultShopName');
    const completedLabel = completedGroups.length === 1
      ? t('purchase.completedOrdersCountLabel.one', { count: completedGroups.length })
      : t('purchase.completedOrdersCountLabel.other', { count: completedGroups.length });
    return (
      <ReportPdfDocument
        title={t('purchase.titles.purchaseStatementDoc', { name: supplier.name })}
        subtitle={t('purchase.subtitleWithRange', { count: completedLabel, range: rangeLabel })}
        stats={[
          { label: t('purchase.stats.shop'), value: restaurantName },
          { label: t('purchase.stats.totalPurchased'), value: formatMoney(completedTotals.purchased) },
          { label: t('purchase.stats.totalPaid'), value: formatMoney(completedTotals.paid) },
          { label: t('purchase.stats.totalDue'), value: formatMoney(completedTotals.due) },
        ]}
        tables={[{
          title: t('purchase.titles.purchaseStatement'),
          columns: [
            { label: t('purchase.columns.poNumber'), width: 1 },
            { label: t('purchase.columns.dateTime'), width: 1.3 },
            { label: t('purchase.columns.item'), width: 2 },
            { label: t('purchase.columns.qty'), width: 0.8, align: 'right' },
            { label: t('purchase.columns.rate'), width: 0.9, align: 'right' },
            { label: t('common.total'), width: 0.9, align: 'right' },
            { label: t('purchase.columns.paid'), width: 0.9, align: 'right' },
            { label: t('purchase.columns.due'), width: 0.9, align: 'right' },
          ],
          rows: buildCompletedRows(),
          footer: ['', '', '', '', t('purchase.totalsLabel'), formatMoney(completedTotals.purchased), formatMoney(completedTotals.paid), formatMoney(completedTotals.due)],
          emptyMessage: t('purchase.empty.noCompletedPurchases'),
        }]}
      />
    );
  }

  function downloadCompletedPdf() {
    void downloadPdfDocument(buildCompletedPdfDoc(), `${supplier.name.replace(/\s+/g, '_')}_purchase_statement.pdf`);
  }

  function buildCompletedExcelSheet(): ExcelSheet {
    return {
      name: t('purchase.titles.purchaseStatement'),
      columnWidths: [90, 130, 200, 70, 80, 90, 80, 80],
      rows: [
        buildRestaurantNameRow(8, t),
        buildGeneratedAtRow(8, t),
        [
          { value: t('purchase.columns.poNumber'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.dateTime'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.item'), style: { bold: true, bg: '111827', color: 'FFFFFF' } },
          { value: t('purchase.columns.qty'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('purchase.columns.rate'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('common.total'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('purchase.columns.paid'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
          { value: t('purchase.columns.due'), style: { bold: true, bg: '111827', color: 'FFFFFF', align: 'Right' } },
        ],
        ...completedGroups.flatMap((g) => g.items.map((item) => [
          { value: g.purchaseOrderNumber },
          { value: formatPurchaseDateTime(item.receivedAt || g.purchaseDate) },
          { value: `${item.ingredientName}${item.productDetails ? ` · ${item.productDetails}` : ''}` },
          { value: `${item.quantity}${item.unit}`, style: { align: 'Right' as const } },
          { value: item.rate, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: item.totalAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: item.paidAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
          { value: item.remainingAmount, style: { align: 'Right' as const, format: '"Rs "#,##0.00' } },
        ])),
        [
          { value: '' }, { value: '' }, { value: '' }, { value: '' },
          { value: t('purchase.totalsLabel'), style: { bold: true } },
          { value: completedTotals.purchased, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
          { value: completedTotals.paid, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
          { value: completedTotals.due, style: { bold: true, align: 'Right', format: '"Rs "#,##0.00' } },
        ],
      ],
    };
  }

  function downloadCompletedExcel() {
    downloadExcelWorkbook([buildCompletedExcelSheet()], `${supplier.name.replace(/\s+/g, '_')}_purchase_statement.xls`);
  }

  async function sendCompletedWhatsapp() {
    if (!supplier.phone.trim()) {
      toast.error(t('purchase.toast.noWhatsappNumber', { name: supplier.name }));
      return;
    }
    try {
      setSendingWhatsapp(true);
      const base64 = await pdfDocumentToBase64(buildCompletedPdfDoc());
      await sendWhatsappDocument(supplier.phone, base64, `${supplier.name.replace(/\s+/g, '_')}_purchase_statement.pdf`);
      toast.success(t('purchase.toast.statementSent', { name: supplier.name }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('purchase.toast.whatsappSendFailed'));
    } finally {
      setSendingWhatsapp(false);
    }
  }

  function downloadPdf() { if (stream === 'pending') downloadPendingPdf(); else downloadCompletedPdf(); }
  function downloadExcel() { if (stream === 'pending') downloadPendingExcel(); else downloadCompletedExcel(); }
  function sendWhatsapp() { void (stream === 'pending' ? sendPendingWhatsapp() : sendCompletedWhatsapp()); }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-4 border-b border-slate-50 p-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="rounded-xl bg-slate-50 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-slate-500 hover:bg-slate-100">
            <span className="rtl:hidden">← </span>{t('purchase.tabs.all')}<span className="hidden rtl:inline"> →</span>
          </button>
          <div>
            <h3 className="text-lg font-black text-slate-900">{supplier.name}</h3>
            <p className="text-xs font-bold text-slate-400">{supplier.phone || t('purchase.supplierDashboard.noWhatsappOnFile')}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex bg-slate-50 p-1 rounded-2xl">
            {(['daily', 'monthly', 'custom'] as Preset[]).map((item) => (
              <button
                key={item}
                onClick={() => applyPreset(item)}
                className={`px-4 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wide transition-all capitalize ${
                  preset === item ? 'bg-slate-900 text-white' : 'text-slate-400 hover:text-slate-600'
                }`}
              >
                {t(`purchase.preset.${item}`)}
              </button>
            ))}
          </div>
          {preset === 'custom' ? (
            <div className="flex items-center gap-1.5">
              <input type="date" value={rangeFrom} max={rangeTo || todayKey} onChange={(e) => setRangeFrom(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold outline-none focus:border-indigo-400" />
              <span className="text-[10px] font-black text-slate-400">{t('purchase.rangeTo')}</span>
              <input type="date" value={rangeTo} min={rangeFrom} max={todayKey} onChange={(e) => setRangeTo(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[10px] font-bold outline-none focus:border-indigo-400" />
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-4 border-b border-slate-50 px-8 py-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-2 rounded-2xl bg-slate-50 p-1">
          <button type="button" onClick={() => setStream('pending')} className={`rounded-xl px-4 py-2 text-xs font-black uppercase tracking-wide transition-colors ${stream === 'pending' ? 'bg-blue-600 text-white' : 'text-slate-500'}`}>
            {t('purchase.supplierDashboard.pendingCount', { count: pendingGroups.length })}
          </button>
          <button type="button" onClick={() => setStream('completed')} className={`rounded-xl px-4 py-2 text-xs font-black uppercase tracking-wide transition-colors ${stream === 'completed' ? 'bg-emerald-600 text-white' : 'text-slate-500'}`}>
            {t('purchase.supplierDashboard.completedCount', { count: completedGroups.length })}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={downloadPdf} className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-200">
            <Download size={14} /> PDF
          </button>
          <button type="button" onClick={downloadExcel} className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-slate-600 hover:bg-slate-200">
            <FileSpreadsheet size={14} /> Excel
          </button>
          <button type="button" disabled={sendingWhatsapp} onClick={sendWhatsapp} className="flex items-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-[10px] font-black uppercase tracking-wide text-emerald-600 hover:bg-emerald-100 disabled:opacity-50">
            <MessageCircle size={14} /> {sendingWhatsapp ? t('purchase.supplierDashboard.sending') : 'WhatsApp'}
          </button>
        </div>
      </div>

      {stream === 'completed' ? (
        <div className="grid grid-cols-1 gap-4 px-4 py-5 sm:grid-cols-3 sm:px-8">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-[10px] font-black uppercase text-slate-400">{t('purchase.stats.totalPurchased')}</p>
            <p className="text-lg font-black text-slate-900">{formatMoney(completedTotals.purchased)}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-[10px] font-black uppercase text-slate-400">{t('purchase.stats.totalPaid')}</p>
            <p className="text-lg font-black text-emerald-600">{formatMoney(completedTotals.paid)}</p>
          </div>
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="text-[10px] font-black uppercase text-slate-400">{t('purchase.stats.totalDue')}</p>
            <p className="text-lg font-black text-rose-600">{formatMoney(completedTotals.due)}</p>
          </div>
        </div>
      ) : null}

      <div className="flex-1 overflow-x-auto">
        <table className="w-full text-left rtl:text-right">
          <thead>
            <tr className="text-slate-400 text-[10px] uppercase tracking-widest font-black">
              <th className="px-8 py-4">{t('purchase.table.orderInfo')}</th>
              <th className="px-8 py-4">{t('purchase.table.items')}</th>
              {stream === 'completed' ? <th className="px-8 py-4 text-right rtl:text-left">{t('purchase.supplierDashboard.totalDueColumn')}</th> : null}
              <th className="px-8 py-4 text-right rtl:text-left">{t('purchase.table.action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {loading ? (
              <tr><td colSpan={4} className="px-8 py-10 text-center text-sm font-bold text-slate-400 animate-pulse">{t('common.loading')}</td></tr>
            ) : activeGroups.length === 0 ? (
              <tr><td colSpan={4} className="px-8 py-10 text-center text-sm font-bold text-slate-400">{t('purchase.supplierDashboard.noStreamOrders', { stream: stream === 'pending' ? t('purchase.supplierDashboard.streamPending') : t('purchase.supplierDashboard.streamCompleted') })}</td></tr>
            ) : (
              activeGroups.map((po) => (
                <tr key={po.purchaseOrderNumber} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-8 py-5">
                    <div className="text-sm font-black text-slate-900">{po.purchaseOrderNumber}</div>
                    <div className="text-[10px] font-bold text-slate-400 uppercase">{formatDisplayDate(po.purchaseDate)}</div>
                  </td>
                  <td className="px-8 py-5">
                    <span className="text-sm font-black text-slate-900">
                      {po.itemCount === 1
                        ? t('purchase.itemCountLabel.one', { count: po.itemCount })
                        : t('purchase.itemCountLabel.other', { count: po.itemCount })}
                    </span>
                    <p className="text-[10px] font-bold text-slate-400 truncate max-w-[220px]">{po.totalQuantityLabel}</p>
                  </td>
                  {stream === 'completed' ? (
                    <td className="px-8 py-5 text-right rtl:text-left">
                      <div className="text-sm font-black text-slate-900">{formatMoney(po.totalAmount)}</div>
                      {po.remainingAmount > 0 ? (
                        <div className="text-[10px] font-bold text-rose-500 uppercase">{t('purchase.sidebar.dueAmount', { amount: formatMoney(po.remainingAmount) })}</div>
                      ) : (
                        <div className="text-[10px] font-bold text-emerald-500 uppercase">{t('purchase.status.paidInFull')}</div>
                      )}
                    </td>
                  ) : null}
                  <td className="px-8 py-5 text-right rtl:text-left">
                    {po.status === 'pending' ? (
                      <button type="button" onClick={() => onReceiveClick(po)} className="rounded-xl bg-emerald-500 px-4 py-2 text-[10px] font-black uppercase tracking-wide text-white hover:bg-emerald-600 transition-colors">
                        {t('purchase.receiveModal.receiveAndBill')}
                      </button>
                    ) : (
                      <span className="text-[10px] font-bold text-slate-300">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
