export const accounting = {
  title: "مالی کھاتہ",
  subtitle: "مالی سال 2026 • سہ ماہی 1",
  actions: {
    exportPdf: "PDF ایکسپورٹ کریں",
    addEntry: "اندراج شامل کریں",
  },
  cards: {
    totalBalance: "کل بیلنس",
    balanceChange: "+Rs {{amount}} اس ہفتے",
    totalRevenue: "کل آمدنی",
    opExpenses: "آپریشنل اخراجات",
    expensePercent: "کل آمدنی کا {{percent}}%",
  },
  ledger: {
    title: "جنرل لیجر",
    description: "تفصیل",
    amount: "رقم",
  },
  budgeting: {
    title: "بجٹ",
    adjustBudgets: "بجٹ ایڈجسٹ کریں",
  },
  profitTarget: {
    title: "منافع کا ہدف",
    description: "آپ اپنے ماہانہ ہدف کے {{percent}}% تک پہنچ چکے ہیں۔",
    goalSuffix: "/ {{goal}}",
  },
} as const;
