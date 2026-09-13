export const payroll = {
  title: "تنخواہ",
  subtitle: "ہر ملازم کا واجب الادا، لیا گیا اور اس ماہ باقی رقم۔",

  summary: {
    totalMonthlyPayroll: "کل ماہانہ تنخواہیں",
    totalMonthlyPayrollHint: "ہر ملازم کی ماہانہ تنخواہ کا مجموعہ",
    paidSoFarThisMonth: "اس ماہ تک ادا شدہ",
    paidSoFarThisMonthHint: "تنخواہ + ایڈوانس، منہا کٹوتیاں",
    remainingToPay: "باقی ادا کرنی ہے",
    acrossStaffMember: "{{count}} ملازم میں",
    acrossStaffMembers: "{{count}} ملازمین میں",
  },

  table: {
    staffPaySummary: "عملے کی تنخواہ کا خلاصہ",
    staffMember: "ملازم",
    designation: "عہدہ",
    monthlySalary: "ماہانہ تنخواہ",
    takenThisMonth: "اس ماہ لی گئی رقم",
    remaining: "باقی رقم",
    noStaffYet: "ابھی تک کوئی ملازم نہیں۔ عملہ منظم کریں سے شامل کریں۔",
    bonusSuffix: "+Rs {{amount}} بونس",
    statusOverpaid: "زیادہ ادا شدہ",
    statusSettled: "مکمل ادا شدہ",
    statusLeft: "باقی",
    history: "تاریخ",
    recordPayment: "ادائیگی درج کریں",
    loadMore: "مزید دکھائیں ({{count}} مزید)",
  },

  transactions: {
    heading: "اس ماہ کی ادائیگیاں",
    type: "قسم",
    amount: "رقم",
    note: "نوٹ",
    noneThisMonth: "اس ماہ ابھی تک کوئی ادائیگی درج نہیں ہوئی۔",
    loadMore: "مزید دکھائیں ({{count}} مزید)",
  },

  types: {
    salary: "تنخواہ",
    advance: "ایڈوانس",
    bonus: "بونس",
    deduction: "کٹوتی",
  },

  toasts: {
    mealLogged: "کھانے کا خرچہ درج کر دیا گیا۔",
    paymentRecorded: "ادائیگی درج کر دی گئی۔",
  },

  recordModal: {
    enterValidAmount: "ایک درست رقم درج کریں۔",
    failedToRecordPayment: "ادائیگی درج نہیں ہو سکی",
    title: "ادائیگی درج کریں",
    remainingThisMonth: "{{name}} · اس ماہ Rs {{amount}} باقی ہیں",
    typeLabel: "قسم",
    amountLabel: "رقم",
    noteLabel: "نوٹ (اختیاری)",
    notePlaceholder: "مثلاً مہینے کے درمیان ایڈوانس",
    savePayment: "ادائیگی محفوظ کریں",
  },

  historyModal: {
    salaryHistoryTitle: "{{name}} کی تنخواہ کی تاریخ",
    monthUsername: "{{month}} · @{{username}}",
    monthlySalary: "ماہانہ تنخواہ",
    paidThisMonth: "اس ماہ ادا شدہ",
    bonus: "بونس",
    remaining: "باقی رقم",
    overpaidSuffix: " (زیادہ ادا شدہ)",
    paymentHistory: "ادائیگی کی تاریخ",
    noPaymentsThisMonth: "اس ماہ کوئی ادائیگی درج نہیں ہوئی۔",
    mealsThisMonth: "اس ماہ ملازمین کے کھانے",
    mealsHint: "صرف حوالے کے لیے دکھایا گیا ہے - اس ملازم کی تنخواہ سے کاٹا نہیں جاتا۔",
    mealAmountPlaceholder: "رقم",
    mealNotePlaceholder: "نوٹ (مثلاً لنچ)",
    logMeal: "کھانا درج کریں",
  },
} as const;
