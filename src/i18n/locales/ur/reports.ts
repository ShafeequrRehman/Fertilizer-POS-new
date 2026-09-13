export const reports = {
  noAccessMessage: "آپ کو ابھی تک کسی بھی رپورٹ ویو تک رسائی حاصل نہیں ہے۔",

  presets: {
    daily: "روزانہ",
    monthly: "ماہانہ",
    yearly: "سالانہ",
    custom: "اپنی مرضی کا",
  },
  to: "تا",

  orderCount: "{{count}} آرڈر",
  orderCountPlural: "{{count}} آرڈرز",
  entryCount: "{{count}} اندراج",
  entryCountPlural: "{{count}} اندراجات",

  allEmployees: "تمام ملازمین",
  allCategories: "تمام اقسام",
  noSpecificEmployee: "کوئی مخصوص ملازم نہیں",
  amountPlaceholder: "رقم",
  notePlaceholder: "نوٹ (اختیاری)",

  tableHeaders: {
    company: "کمپنی",
    product: "پروڈکٹ",
    paid: "ادا شدہ",
    due: "باقی",
    order: "آرڈر",
    type: "قسم",
  },

  expense: {
    missingInfoTitle: "معلومات نامکمل ہیں",
    pickCategoryMessage: "کوئی قسم منتخب کریں یا لکھیں۔",
    enterAmountMessage: "0 سے زیادہ رقم درج کریں۔",
    logErrorTitle: "خرچہ درج نہیں ہو سکا",
    logErrorMessage: "خرچہ درج کرنے میں ناکامی۔",
    deleteConfirmTitle: "خرچہ حذف کریں",
    deleteConfirmMessage: "{{category}} کا یہ {{amount}} کا خرچہ حذف کریں؟",
    deleteErrorTitle: "حذف نہیں ہو سکا",
    deleteErrorMessage: "خرچہ حذف کرنے میں ناکامی۔",
  },

  dayEnd: {
    loadError: "رپورٹ لوڈ کرنے میں ناکامی۔",
    title: "یومیہ منافع رپورٹ",
    subtitle: "آمدنی، خام مال کی لاگت، اور اخراجات - آپ کے منتخب کردہ عرصے کا خالص منافع۔",

    totalRevenue: "کل آمدنی",
    productCost: "پروڈکٹ لاگت (COGS)",
    ingredientsConsumed: "استعمال شدہ اجزاء",
    otherExpenses: "دیگر اخراجات",
    expenseCountLogged: "{{count}} درج شدہ",
    netProfit: "خالص منافع",
    netProfitFormula: "آمدنی - COGS - اخراجات",

    expenseBreakdownTitle: "اخراجات کی تفصیل",
    expenseBreakdownSubtitle: "قسم کے مطابق، اس عرصے کے لیے",
    noExpenses: "اس عرصے میں کوئی خرچہ درج نہیں ہوا۔",
    notInNetProfitBadge: "خالص منافع میں شامل نہیں",
    rawStockCostedNote: "خام اسٹاک فروخت ہونے پر پہلے ہی COGS میں شمار ہو چکا ہے",

    employeeMeals: "ملازمین کا کھانا",
    salaryPaymentsAdvances: "تنخواہ ادائیگیاں/ایڈوانس",
    totalEmployeeExpenses: "ملازمین کے کل اخراجات",
    overallExpenses: "مجموعی اخراجات",

    entriesInPeriod: "اس عرصے کے اندراجات",
    nothingLoggedYet: "ابھی تک کچھ درج نہیں ہوا۔",

    logExpenseTitle: "خرچہ درج کریں",
    logExpenseSubtitle: "گیس، بجلی، تنخواہیں، نقصان/ضیاع، ملازمین کا کھانا...",
    loggedAgainst: "{{date}} کے خلاف درج کیا گیا۔",
    logExpenseButton: "خرچہ درج کریں",
  },

  mySales: {
    loadError: "آپ کی سیلز رپورٹ لوڈ کرنے میں ناکامی۔",
    title: "میری روزانہ سیلز",
    subtitle: "صرف وہ آرڈرز جو آپ نے خود دیے، ایک دن کے حساب سے۔",

    myRevenue: "میری آمدنی",
    collected: "وصول شدہ",
    cashReceived: "موصولہ نقدی",
    stillDue: "ابھی باقی",
    acrossYourOrders: "آپ کے تمام آرڈرز میں",
    cancelled: "منسوخ شدہ",
    notCountedAbove: "اوپر شمار نہیں کیا گیا",

    yourOrdersTitle: "آپ کے آرڈرز",
    noOrders: "اس دن کوئی آرڈر نہیں۔",
  },

  inventory: {
    loadError: "انوینٹری رپورٹ لوڈ کرنے میں ناکامی۔",
    title: "اسٹاک اور سپلائر رپورٹ",
    subtitle: "آپ کے منتخب کردہ عرصے کے کچن اسٹاک خریداری لاگ اور سپلائر واجبات۔",

    kitchenStockPurchased: "کچن اسٹاک خریدا گیا",
    batchesLogged: "{{count}} کھیپیں درج شدہ",
    totalSupplierDue: "کل سپلائر واجبات",
    allTimeEveryCompany: "ہر کمپنی، اب تک",
    companiesOwed: "واجب الادا کمپنیاں",
    withOutstandingBalance: "بقایا رقم کے ساتھ",

    supplierDuesTitle: "سپلائر واجبات",
    supplierDuesSubtitle: "ہر کمپنی کا اب تک کا بقایا",
    nothingDue: "کسی کمپنی کا کچھ واجب نہیں۔",

    kitchenStockLogTitle: "کچن اسٹاک لاگ",
    kitchenStockLogSubtitle: "اس عرصے میں درج ہر کھیپ",
    noPurchases: "اس عرصے میں کوئی خریداری درج نہیں ہوئی۔",
    dueSuffix: "باقی",
  },
} as const;
