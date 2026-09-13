// AccountingPage.tsx - shop expense/ledger tracking (financial summary
// cards, general ledger table, budgeting sidebar).
export const accounting = {
  title: "Financial Ledger",
  subtitle: "Fiscal Year 2026 • Period Q1",
  actions: {
    exportPdf: "Export PDF",
    addEntry: "Add Entry",
  },
  cards: {
    totalBalance: "Total Balance",
    balanceChange: "+Rs {{amount}} this week",
    totalRevenue: "Total Revenue",
    opExpenses: "Op. Expenses",
    expensePercent: "{{percent}}% of gross",
  },
  ledger: {
    title: "General Ledger",
    description: "Description",
    amount: "Amount",
  },
  budgeting: {
    title: "Budgeting",
    adjustBudgets: "Adjust Budgets",
  },
  profitTarget: {
    title: "Profit Target",
    description: "You are {{percent}}% towards your monthly goal.",
    goalSuffix: "/ {{goal}}",
  },
} as const;
