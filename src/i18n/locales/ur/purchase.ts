export const purchase = {
  header: {
    title: "خریداری",
    subtitle: "سپلائی چین اور اسٹاک کی دوبارہ بھرائی کا انتظام کریں۔",
  },
  searchPlaceholder: "پی او نمبر یا سپلائر تلاش کریں...",
  newPurchaseOrder: "نیا خریداری آرڈر",
  defaultShopName: "دکان",
  unspecifiedCompany: "غیر متعین",
  generatedAt: "تیار کردہ: {{date}}",

  lowStock: {
    title: "کم اسٹاک وارننگ",
    messageOne: "{{count}} آئٹم حفاظتی حد سے کم ہے۔ دوبارہ اسٹاک کی سفارش کی جاتی ہے۔",
    messageOther: "{{count}} آئٹمز حفاظتی حد سے کم ہیں۔ دوبارہ اسٹاک کی سفارش کی جاتی ہے۔",
    autoGenerate: "خودکار پی او بنائیں",
  },

  sidebar: {
    suppliersTitle: "سپلائرز",
    suppliersTotal: "کل {{count}}",
    noSuppliers: 'ابھی کوئی سپلائر کمپنی رجسٹرڈ نہیں - "{{action}}" سے ایک شامل کریں۔',
    dueAmount: "{{amount}} واجب الادا",
    monthlySpend: "ماہانہ خرچ",
    activePOs: "فعال پی اوز: {{count}}",
  },

  tabs: {
    all: "تمام آرڈرز",
    pendingDispatched: "زیر التوا / روانہ شدہ",
  },

  preset: {
    daily: "روزانہ",
    monthly: "ماہانہ",
    custom: "حسب ضرورت",
  },
  rangeTo: "تا",
  resetFilters: "فلٹرز ری سیٹ کریں",

  status: {
    received: "موصول ہو گیا",
    pending: "زیر التوا",
    paidInFull: "مکمل ادائیگی",
    awaitingDelivery: "ترسیل کا انتظار",
  },

  itemCountLabel: {
    one: "{{count}} آئٹم",
    other: "{{count}} آئٹمز",
  },
  ordersCountLabel: {
    one: "{{count}} آرڈر",
    other: "{{count}} آرڈرز",
  },
  companiesCountLabel: {
    one: "{{count}} کمپنی",
    other: "{{count}} کمپنیاں",
  },
  pendingOrdersCountLabel: {
    one: "{{count}} زیر التوا آرڈر",
    other: "{{count}} زیر التوا آرڈرز",
  },
  completedOrdersCountLabel: {
    one: "{{count}} مکمل آرڈر",
    other: "{{count}} مکمل آرڈرز",
  },

  columns: {
    poNumber: "پی او #",
    dateTime: "تاریخ اور وقت",
    item: "آئٹم",
    qty: "مقدار",
    quantity: "مقدار",
    rate: "ریٹ",
    paid: "ادا شدہ",
    due: "واجب الادا",
  },

  stats: {
    shop: "دکان",
    totalPurchased: "کل خریداری",
    totalPaid: "کل ادا شدہ",
    totalDue: "کل واجب الادا",
    pendingOrders: "زیر التوا آرڈرز",
    lineItems: "لائن آئٹمز",
  },

  titles: {
    masterPurchaseLogAllCompanies: "ماسٹر خریداری لاگ — تمام کمپنیاں",
    demandRequirementSheet: "ڈیمانڈ ریکوائرمنٹ شیٹ",
    demandSheetDoc: "{{name}} — ڈیمانڈ شیٹ",
    purchaseStatementDoc: "{{name}} — خریداری اسٹیٹمنٹ",
    purchaseStatement: "خریداری اسٹیٹمنٹ",
  },

  sheetNames: {
    masterPurchaseLog: "ماسٹر خریداری لاگ",
    demandSheet: "ڈیمانڈ شیٹ",
  },

  empty: {
    noOrders: "اس مدت میں اس کمپنی کے لیے کوئی آرڈر نہیں۔",
    noPendingOrders: "اس مدت میں اس کمپنی کے لیے کوئی زیر التوا آرڈر نہیں۔",
    noCompletedPurchases: "اس مدت میں اس کمپنی کی کوئی مکمل خریداری نہیں۔",
  },
  totalsLabel: "مجموعے",

  masterExport: {
    heading: "ماسٹر ایکسپورٹ - تمام کمپنیاں",
    summary: "{{companies}} · {{orders}} اس مدت میں",
    summaryWithRange: "{{companies}} · {{orders}} · {{range}}",
    downloadPdf: "پی ڈی ایف ڈاؤن لوڈ کریں",
    downloadExcel: "ایکسل ڈاؤن لوڈ کریں",
  },

  subtitleWithRange: "{{count}} · {{range}}",

  table: {
    orderInfo: "آرڈر کی معلومات",
    supplier: "سپلائر",
    items: "آئٹمز",
    totalCost: "کل لاگت",
    action: "عمل",
    loading: "خریداری آرڈرز لوڈ ہو رہے ہیں...",
    noMatches: "موجودہ فلٹرز سے کوئی خریداری آرڈر مماثل نہیں ہے۔",
    markReceived: "موصول شدہ نشان زد کریں",
  },

  newOrderModal: {
    subtitle: "فیز 1 - آرڈر دیا گیا۔ اسٹاک صرف موصول شدہ نشان زد ہونے پر اپ ڈیٹ ہوگا۔",
    supplierCompanyLabel: "سپلائر کمپنی",
    noCompaniesOption: "ابھی کوئی کمپنی نہیں - ایک شامل کریں",
    selectSupplierOption: "ایک سپلائر کمپنی منتخب کریں",
    newSupplierButton: "+ نئی",
    companyNamePlaceholder: "کمپنی کا نام",
    phonePlaceholder: "فون (اختیاری)",
    orderDateLabel: "آرڈر کی تاریخ",
    addItem: "آئٹم شامل کریں",
    itemsHint: "صرف اجزاء + مقدار - سپلائر ریٹ بعد میں درج کیا جائے گا، جب ڈیلیوری واقعی پہنچے گی۔",
    selectIngredientOption: "جزو منتخب کریں",
    noteLabel: "نوٹ (اختیاری)",
    creating: "بنایا جا رہا ہے...",
    submit: "خریداری آرڈر بنائیں",
  },

  receiveModal: {
    title: "موصول کریں اور بل بنائیں {{po}}",
    subtitle: "{{company}} - ہر موصول شدہ آئٹم کے لیے اصل سپلائر ریٹ درج کریں۔",
    totalBill: "کل بل",
    fullPay: "مکمل ادائیگی",
    partialDues: "جزوی (واجبات)",
    amountPaidNowLabel: "ابھی ادا کی گئی رقم",
    upToPlaceholder: "زیادہ سے زیادہ Rs {{amount}}",
    remainingDue: "باقی واجب الادا",
    receiving: "موصول کیا جا رہا ہے...",
    confirmSubmit: "موصول ہونے کی تصدیق کریں اور اسٹاک اپ ڈیٹ کریں",
    amountToRecord: "ابھی درج کی جانے والی رقم: {{amount}}",
    receiveAndBill: "موصول کریں اور بل بنائیں",
  },

  supplierDashboard: {
    noWhatsappOnFile: "کوئی واٹس ایپ نمبر درج نہیں",
    pendingCount: "زیر التوا ({{count}})",
    completedCount: "مکمل ({{count}})",
    sending: "بھیجا جا رہا ہے...",
    totalDueColumn: "کل / واجب الادا",
    noStreamOrders: "اس مدت میں اس کمپنی کے لیے کوئی {{stream}} آرڈر نہیں۔",
    streamPending: "زیر التوا",
    streamCompleted: "مکمل",
  },

  toast: {
    loadDirectoryFailed: "سپلائرز/اجزاء لوڈ نہیں ہو سکے۔",
    loadPurchasesFailed: "خریداری آرڈرز لوڈ نہیں ہو سکے۔",
    supplierAdded: '"{{name}}" کو بطور سپلائر کمپنی شامل کر دیا گیا۔',
    addSupplierFailed: "یہ سپلائر شامل نہیں ہو سکا۔",
    selectSupplierFirst: "پہلے ایک سپلائر کمپنی منتخب کریں۔",
    addAtLeastOneItem: "کم از کم ایک آئٹم مقدار کے ساتھ شامل کریں۔",
    orderCreated: "خریداری آرڈر {{po}} بن گیا - {{items}}، ترسیل کا انتظار۔",
    createOrderFailed: "یہ خریداری آرڈر نہیں بن سکا۔",
    invalidRate: "{{name}} کے لیے درست ریٹ درج کریں۔",
    receivedSuccess: "{{po}} موصول ہو گیا - اسٹاک اپ ڈیٹ ہو گیا{{suffix}}۔",
    dueSuffix: "، Rs {{amount}} بطور واجب الادا باقی ہے",
    paidInFullSuffix: "، مکمل ادائیگی ہو گئی",
    receiveFailed: "یہ خریداری آرڈر موصول شدہ نشان زد نہیں ہو سکا۔",
    loadSupplierHistoryFailed: "اس سپلائر کی خریداری کی تاریخ لوڈ نہیں ہو سکی۔",
    noWhatsappNumber: '"{{name}}" کے لیے پہلے واٹس ایپ نمبر شامل کریں۔',
    demandSheetSent: "ڈیمانڈ شیٹ {{name}} کو واٹس ایپ پر بھیج دی گئی۔",
    statementSent: "خریداری اسٹیٹمنٹ {{name}} کو واٹس ایپ پر بھیج دی گئی۔",
    whatsappSendFailed: "واٹس ایپ پیغام نہیں بھیجا جا سکا۔ یقینی بنائیں کہ سیٹنگز میں واٹس ایپ منسلک ہے۔",
  },
} as const;
