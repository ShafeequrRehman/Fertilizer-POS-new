// Manage Staff page (Employees tab + Roles & Permissions tab) - see
// src/pages/dashboard/EmployeesPage.tsx. Covers the staff list table, the
// staff details/create/edit modals, password reset, role editor, and the
// per-employee permission-override modal.
export const employees = {
  title: "عملہ منظم کریں",
  offlineBadge: "آف لائن — تبدیلیاں خود بخود سنک ہو جائیں گی",
  subtitle: "عملے کے اکاؤنٹس، عہدے، ڈائریکٹری کی تفصیلات، اور وہ کردار جو یہ کنٹرول کرتے ہیں کہ وہ کیا دیکھ اور کر سکتے ہیں۔",
  newStaffMember: "نیا عملہ رکن",
  newRole: "نیا کردار",

  tabs: {
    staff: "عملہ",
    rolesPermissions: "کردار اور اجازتیں",
  },

  table: {
    designation: "عہدہ",
    username: "یوزر نیم",
    role: "کردار",
    noStaffYet: "ابھی تک کوئی عملہ رکن نہیں۔",
  },

  actions: {
    viewFullDetails: "مکمل تفصیلات دیکھیں",
    editStaffDetails: "عملے کی تفصیلات میں ترمیم کریں",
    grantRevokePermissions: "انفرادی اجازتیں دیں یا واپس لیں",
    resetPassword: "پاس ورڈ ری سیٹ کریں",
    remove: "ہٹائیں",
  },

  confirmRemoveTitle: "عملہ رکن ہٹائیں",
  confirmRemoveMessage: '"{{name}}" کو عملے سے ہٹائیں؟',
  removeButton: "ہٹائیں",
  staffRemoved: '"{{name}}" ہٹا دیا گیا۔',
  couldNotLoadStaffLocalHub: "عملہ لوڈ نہیں ہو سکا - لوکل حب دستیاب نہیں۔",
  failedToLoadStaff: "عملہ لوڈ کرنے میں ناکامی۔",

  roles: {
    confirmDeleteTitle: "کردار حذف کریں",
    confirmDeleteMessage: 'کردار "{{name}}" حذف کریں؟',
    deleted: 'کردار "{{name}}" حذف کر دیا گیا۔',
    failedToDelete: "کردار حذف کرنے میں ناکامی",
    hidesDashboardBadge: "ڈیش بورڈ چھپاتا ہے",
    noPermissionsAssigned: "کوئی اجازت مقرر نہیں",
  },

  fields: {
    fullName: "پورا نام",
    username: "یوزر نیم",
    designation: "عہدہ",
    role: "کردار",
    email: "ای میل",
    phoneNumber: "فون نمبر",
    idCardNumber: "شناختی کارڈ نمبر",
    address: "پتہ",
    vehicleNumber: "گاڑی / بائیک نمبر",
    reference: "حوالہ",
    monthlySalary: "ماہانہ تنخواہ",
    comment: "تبصرہ",
  },

  details: {
    title: "عملے کی تفصیلات — {{name}}",
    editDetails: "تفصیلات میں ترمیم کریں",
  },

  form: {
    titleEdit: "عملہ میں ترمیم — {{name}}",
    resetPasswordHint: 'پاس ورڈ تبدیل کرنے کے لیے "پاس ورڈ ری سیٹ کریں" استعمال کریں۔',
    password: "پاس ورڈ",
    emailOptional: "ای میل (اختیاری)",
    roleSelectLabel: "کردار (اجازتیں)",
    selectRole: "ایک کردار منتخب کریں",
    designationLabel: "عہدہ (جاب ٹائٹل - ویٹر/آرڈر ٹیکر POS ویٹر لسٹ میں نظر آتے ہیں)",
    customDesignationPlaceholder: "مثلاً بریسٹا",
    chooseFromList: "فہرست سے منتخب کریں",
    selectDesignation: "ایک عہدہ منتخب کریں",
    otherCustom: "دیگر (خود لکھیں)…",
    saveChanges: "تبدیلیاں محفوظ کریں",
    createStaffMember: "عملہ رکن بنائیں",
    failedToUpdate: "عملہ رکن اپ ڈیٹ کرنے میں ناکامی",
    failedToCreate: "عملہ رکن بنانے میں ناکامی",
  },

  resetPasswordModal: {
    doneTitle: "پاس ورڈ ری سیٹ ہو گیا",
    passwordUpdatedMessage: "عملہ رکن کا پاس ورڈ اپ ڈیٹ کر دیا گیا ہے۔",
    done: "مکمل",
    title: "پاس ورڈ ری سیٹ کریں — {{name}}",
    newPasswordLabel: "نیا پاس ورڈ",
    failedToReset: "پاس ورڈ ری سیٹ کرنے میں ناکامی",
    resetPasswordButton: "پاس ورڈ ری سیٹ کریں",
  },

  roleEditor: {
    titleEdit: "کردار میں ترمیم — {{name}}",
    roleNameLabel: "کردار کا نام",
    hideDashboardLabel: "ڈیش بورڈ چھپائیں",
    hideDashboardDescription: "اس کردار والا عملہ لاگ ان کے بعد مین ڈیش بورڈ ہوم پیج نہیں دیکھ سکے گا یا کھول سکے گا - وہ اس کے بجائے اپنے پہلے دستیاب صفحے پر جائیں گے۔",
    failedToSave: "کردار محفوظ کرنے میں ناکامی",
    saveRole: "کردار محفوظ کریں",
  },

  permissionsModal: {
    title: "اجازتیں — {{name}}",
    description: "یہ اس اکاؤنٹ کے کردار سے شروع ہوتا ہے۔ کسی اجازت کو خاص طور پر {{name}} کو دینے کے لیے باکس چیک کریں؛ اسے صرف اس اکاؤنٹ کے لیے واپس لینے کے لیے وہ باکس ان چیک کریں جو ان کا کردار عام طور پر دیتا ہے۔",
    updated: '"{{name}}" کے لیے اجازتیں اپ ڈیٹ ہو گئیں۔',
    failedToSave: "اجازتیں محفوظ کرنے میں ناکامی",
    added: "شامل کی گئی",
    removed: "ہٹائی گئی",
    roleDefault: "کردار کی ڈیفالٹ",
    savePermissions: "اجازتیں محفوظ کریں",
  },
} as const;
