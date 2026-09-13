export const shopClosingSummary = {
  header: {
    title: "روزانہ شاپ بندش اور Z-رپورٹ",
    subtitle: "دن کے اختتام پر مالیاتی مصالحت",
  },

  loading: "آج کے اعداد و شمار لوڈ ہو رہے ہیں...",
  loadError: "بندش کا خلاصہ لوڈ نہیں ہو سکا۔",

  stats: {
    totalRevenue: "کل آمدنی",
    netProfit: "خالص منافع",
    totalOrders: "کل آرڈرز",
    outstandingDue: "بقایا رقم",
  },

  expensesBreakdown: {
    title: "اخراجات کی تفصیل",
    kitchenStock: "کچن سٹاک (اجزاء کی خریداری)",
    manualOperations: "دستی آپریشنز (دیگر اخراجات)",
  },

  ordersByType: {
    title: "آرڈرز بلحاظ قسم",
    dineIn: "ڈائن اِن",
    takeaway: "ٹیک اوے",
    delivery: "ڈیلیوری",
  },

  sendToOwner: {
    title: "مالک کو بھیجیں",
    phonePlaceholder: "مالک کا واٹس ایپ نمبر",
  },

  printReceipt: "رسید پرنٹ کریں",
  sendWhatsapp: "واٹس ایپ بھیجیں",
  sending: "بھیجا جا رہا ہے...",
  confirmAndCloseShop: "تصدیق کریں اور شاپ بند کریں",
  closingInProgress: "بند ہو رہا ہے...",

  toasts: {
    enterPhoneFirst: "پہلے مالک کا واٹس ایپ نمبر درج کریں۔",
    sentToWhatsapp: "بندش کا خلاصہ مالک کو واٹس ایپ پر بھیج دیا گیا۔",
    whatsappSendError: "واٹس ایپ پیغام نہیں بھیجا جا سکا۔ یقینی بنائیں کہ واٹس ایپ ترتیبات میں منسلک ہے۔",
  },
} as const;
