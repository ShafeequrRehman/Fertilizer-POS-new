// Purchase Orders / Supplier Stock-In page (PurchasePage.tsx) - covers the
// unified Purchase Log, the New Purchase Order + Receive & Bill modals, the
// Per-Supplier Dashboard, and the text embedded inside its PDF/Excel export
// builders (those exported documents are read by humans too, so their
// labels count as user-facing the same as on-screen text).
export const purchase = {
  header: {
    title: "Procurement",
    subtitle: "Manage supply chain and stock replenishment.",
  },
  searchPlaceholder: "Track PO number or supplier...",
  newPurchaseOrder: "New Purchase Order",
  defaultShopName: "Shop",
  unspecifiedCompany: "Unspecified",
  generatedAt: "Generated: {{date}}",

  lowStock: {
    title: "Low Stock Warning",
    messageOne: "{{count}} item below safety threshold. Restock recommended.",
    messageOther: "{{count}} items below safety threshold. Restock recommended.",
    autoGenerate: "Auto-Generate PO",
  },

  sidebar: {
    suppliersTitle: "Suppliers",
    suppliersTotal: "{{count}} total",
    noSuppliers: 'No registered supplier companies yet - add one from "{{action}}".',
    dueAmount: "{{amount}} due",
    monthlySpend: "Monthly Spend",
    activePOs: "Active POs: {{count}}",
  },

  tabs: {
    all: "All Orders",
    pendingDispatched: "Pending / Dispatched",
  },

  preset: {
    daily: "Daily",
    monthly: "Monthly",
    custom: "Custom",
  },
  rangeTo: "to",
  resetFilters: "Reset filters",

  status: {
    received: "Received",
    pending: "Pending",
    paidInFull: "Paid in full",
    awaitingDelivery: "Awaiting delivery",
  },

  itemCountLabel: {
    one: "{{count}} item",
    other: "{{count}} items",
  },
  ordersCountLabel: {
    one: "{{count}} order",
    other: "{{count}} orders",
  },
  companiesCountLabel: {
    one: "{{count}} company",
    other: "{{count}} companies",
  },
  pendingOrdersCountLabel: {
    one: "{{count}} pending order",
    other: "{{count}} pending orders",
  },
  completedOrdersCountLabel: {
    one: "{{count}} completed order",
    other: "{{count}} completed orders",
  },

  columns: {
    poNumber: "PO #",
    dateTime: "Date & Time",
    item: "Item",
    qty: "Qty",
    quantity: "Quantity",
    rate: "Rate",
    paid: "Paid",
    due: "Due",
  },

  stats: {
    shop: "Shop",
    totalPurchased: "Total Purchased",
    totalPaid: "Total Paid",
    totalDue: "Total Due",
    pendingOrders: "Pending Orders",
    lineItems: "Line Items",
  },

  titles: {
    masterPurchaseLogAllCompanies: "Master Purchase Log — All Companies",
    demandRequirementSheet: "Demand Requirement Sheet",
    demandSheetDoc: "{{name}} — Purchase Demand Sheet",
    purchaseStatementDoc: "{{name}} — Purchase Statement",
    purchaseStatement: "Purchase Statement",
  },

  sheetNames: {
    masterPurchaseLog: "Master Purchase Log",
    demandSheet: "Demand Sheet",
  },

  empty: {
    noOrders: "No orders for this company in this range.",
    noPendingOrders: "No pending orders for this company in this range.",
    noCompletedPurchases: "No completed purchases for this company in this range.",
  },
  totalsLabel: "TOTALS",

  masterExport: {
    heading: "Master Export - All Companies",
    summary: "{{companies}} · {{orders}} in this range",
    summaryWithRange: "{{companies}} · {{orders}} · {{range}}",
    downloadPdf: "Download PDF",
    downloadExcel: "Download Excel",
  },

  subtitleWithRange: "{{count}} · {{range}}",

  table: {
    orderInfo: "Order Info",
    supplier: "Supplier",
    items: "Items",
    totalCost: "Total Cost",
    action: "Action",
    loading: "Loading purchase orders...",
    noMatches: "No purchase orders match the current filters.",
    markReceived: "Mark Received",
  },

  newOrderModal: {
    subtitle: "Phase 1 - Order Placed. Stock updates only once marked Received.",
    supplierCompanyLabel: "Supplier Company",
    noCompaniesOption: "No companies yet - add one",
    selectSupplierOption: "Select a supplier company",
    newSupplierButton: "+ New",
    companyNamePlaceholder: "Company name",
    phonePlaceholder: "Phone (optional)",
    orderDateLabel: "Order Date",
    addItem: "Add Item",
    itemsHint: "Ingredient + Quantity only - the supplier rate is entered later, once the delivery actually arrives.",
    selectIngredientOption: "Select ingredient",
    noteLabel: "Note (optional)",
    creating: "Creating...",
    submit: "Create Purchase Order",
  },

  receiveModal: {
    title: "Receive & Bill {{po}}",
    subtitle: "{{company}} - enter the Actual Supplier Rate for each delivered item.",
    totalBill: "Total Bill",
    fullPay: "Full Pay",
    partialDues: "Partial (Dues)",
    amountPaidNowLabel: "Amount Paid Now",
    upToPlaceholder: "Up to Rs {{amount}}",
    remainingDue: "Remaining Due",
    receiving: "Receiving...",
    confirmSubmit: "Confirm Received & Update Stock",
    amountToRecord: "Amount to record now: {{amount}}",
    receiveAndBill: "Receive & Bill",
  },

  supplierDashboard: {
    noWhatsappOnFile: "No WhatsApp number on file",
    pendingCount: "Pending ({{count}})",
    completedCount: "Completed ({{count}})",
    sending: "Sending...",
    totalDueColumn: "Total / Due",
    noStreamOrders: "No {{stream}} orders for this company in this range.",
    streamPending: "pending",
    streamCompleted: "completed",
  },

  toast: {
    loadDirectoryFailed: "Could not load suppliers/ingredients.",
    loadPurchasesFailed: "Could not load purchase orders.",
    supplierAdded: 'Added "{{name}}" as a supplier company.',
    addSupplierFailed: "Could not add this supplier.",
    selectSupplierFirst: "Select a Supplier Company first.",
    addAtLeastOneItem: "Add at least one item with a quantity.",
    orderCreated: "Purchase Order {{po}} created - {{items}}, awaiting delivery.",
    createOrderFailed: "Could not create this purchase order.",
    invalidRate: "Enter a valid rate for {{name}}.",
    receivedSuccess: "{{po}} received - stock updated{{suffix}}.",
    dueSuffix: ", Rs {{amount}} left as due",
    paidInFullSuffix: ", paid in full",
    receiveFailed: "Could not mark this purchase order received.",
    loadSupplierHistoryFailed: "Could not load this supplier's purchase history.",
    noWhatsappNumber: 'Add a WhatsApp number for "{{name}}" first.',
    demandSheetSent: "Demand sheet sent to {{name}} on WhatsApp.",
    statementSent: "Purchase statement sent to {{name}} on WhatsApp.",
    whatsappSendFailed: "Couldn't send WhatsApp message. Make sure WhatsApp is connected in Settings.",
  },
} as const;
