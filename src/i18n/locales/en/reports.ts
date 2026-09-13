// ReportsPage.tsx - three separate report views (Day-End Profit for
// Owner/Manager/Accountant, My Daily Sales for Receptionist, Stock &
// Supplier for Stock Manager - see that file's own comments for the
// permission branching). Keys are grouped per view, plus a few genuinely
// shared bits (date-range presets, the "to" between two date pickers,
// table headers reused by more than one view, order-count pluralization)
// at the top level.
export const reports = {
  noAccessMessage: "You don't have access to any report view yet.",

  // Daily/Monthly/Yearly/Custom range picker - shared by the Day-End and
  // Inventory views.
  presets: {
    daily: "Daily",
    monthly: "Monthly",
    yearly: "Yearly",
    custom: "Custom",
  },
  to: "to",

  // "{{count}} order"/"{{count}} orders" under the Revenue KPI card - shared
  // by the Day-End and My Sales views.
  orderCount: "{{count}} order",
  orderCountPlural: "{{count}} orders",
  // "{{count}} entry"/"{{count}} entries" next to an expense-breakdown row.
  entryCount: "{{count}} entry",
  entryCountPlural: "{{count}} entries",

  allEmployees: "All employees",
  allCategories: "All categories",
  noSpecificEmployee: "No specific employee",
  amountPlaceholder: "Amount",
  notePlaceholder: "Note (optional)",

  // Table headers reused across the kitchen-stock detail table (Day-End
  // view) and the orders table (My Sales view).
  tableHeaders: {
    company: "Company",
    product: "Product",
    paid: "Paid",
    due: "Due",
    order: "Order",
    type: "Type",
  },

  expense: {
    missingInfoTitle: "Missing information",
    pickCategoryMessage: "Pick or type a category.",
    enterAmountMessage: "Enter an amount greater than 0.",
    logErrorTitle: "Couldn't log expense",
    logErrorMessage: "Failed to log expense.",
    deleteConfirmTitle: "Delete expense",
    deleteConfirmMessage: "Delete this {{category}} expense of {{amount}}?",
    deleteErrorTitle: "Couldn't delete",
    deleteErrorMessage: "Failed to delete expense.",
  },

  dayEnd: {
    loadError: "Failed to load the report.",
    title: "Day-End Profit Report",
    subtitle: "Revenue, ingredient cost, and expenses - net profit for the period you pick.",

    totalRevenue: "Total Revenue",
    productCost: "Product Cost (COGS)",
    ingredientsConsumed: "Ingredients consumed",
    otherExpenses: "Other Expenses",
    expenseCountLogged: "{{count}} logged",
    netProfit: "Net Profit",
    netProfitFormula: "Revenue - COGS - Expenses",

    expenseBreakdownTitle: "Expense Breakdown",
    expenseBreakdownSubtitle: "By category, this period",
    noExpenses: "No expenses logged in this period.",
    notInNetProfitBadge: "Not in Net Profit",
    rawStockCostedNote: "raw stock already costed via COGS when sold",

    employeeMeals: "Employee Meals",
    salaryPaymentsAdvances: "Salary Payments/Advances",
    totalEmployeeExpenses: "Total Employee Expenses",
    overallExpenses: "Overall Expenses",

    entriesInPeriod: "Entries in this period",
    nothingLoggedYet: "Nothing logged yet.",

    logExpenseTitle: "Log an Expense",
    logExpenseSubtitle: "Gas, electricity, wages, damage/waste, employee meals...",
    loggedAgainst: "Logged against {{date}}.",
    logExpenseButton: "Log Expense",
  },

  mySales: {
    loadError: "Failed to load your sales report.",
    title: "My Daily Sales",
    subtitle: "Only the orders you personally placed, one day at a time.",

    myRevenue: "My Revenue",
    collected: "Collected",
    cashReceived: "Cash received",
    stillDue: "Still Due",
    acrossYourOrders: "Across your orders",
    cancelled: "Cancelled",
    notCountedAbove: "Not counted above",

    yourOrdersTitle: "Your Orders",
    noOrders: "No orders on this day.",
  },

  inventory: {
    loadError: "Failed to load the inventory report.",
    title: "Stock & Supplier Report",
    subtitle: "Kitchen stock purchase logs and supplier dues for the period you pick.",

    kitchenStockPurchased: "Kitchen Stock Purchased",
    batchesLogged: "{{count}} batches logged",
    totalSupplierDue: "Total Supplier Due",
    allTimeEveryCompany: "All-time, every company",
    companiesOwed: "Companies Owed",
    withOutstandingBalance: "With an outstanding balance",

    supplierDuesTitle: "Supplier Dues",
    supplierDuesSubtitle: "All-time balance owed, every company",
    nothingDue: "Nothing due to any company.",

    kitchenStockLogTitle: "Kitchen Stock Log",
    kitchenStockLogSubtitle: "Every batch logged this period",
    noPurchases: "No purchases logged in this period.",
    dueSuffix: "due",
  },
} as const;
