// SettingsPage.tsx - the dashboard Settings shell: left-hand section menu,
// the "Shop Profile"/default form (shop name/address, business hours,
// currency/timezone/tax, device toggles), the Hardware/POS section
// (printers + the receipt print logo), and the "Waiter Setup Has Moved"
// notice. Text belonging to sub-sections rendered from their OWN files
// (ProductManagementSection, ReceiptManagementSection, SidebarPagesSection,
// CustomerOrderingSection, ReceiptAutoPrintSection) is NOT here - those are
// separate namespaces owned by their own files.
//
// `menu` labels are ONLY for display - the section ids compared in
// SettingsPage.tsx's own logic (activeSection === "Manage Receipt", etc.)
// stay as plain English strings so this translation pass never touches
// that branching.
export const settings = {
  pageTitle: "System Settings",
  pageSubtitle: "Configure your workspace and global preferences.",
  saveChanges: "Save Changes",

  menu: {
    shopProfile: "Shop Profile",
    manageProducts: "Manage Products",
    manageReceipt: "Manage Receipt",
    sidebarPages: "Sidebar Pages",
    customerOrdering: "Customer Ordering",
    paymentsTax: "Payments & Tax",
    hardwarePos: "Hardware / POS",
    security: "Security",
    notifications: "Notifications",
    backupData: "Backup & Data",
  },

  systemHealth: {
    title: "System Health",
    allOperational: "All systems operational",
  },

  // "Update your {{section}} settings and information." - {{section}} is
  // filled in with the active menu item's own translated (and
  // lower-cased) label.
  sectionSubtitle: "Update your {{section}} settings and information.",

  receiptPrintLogo: {
    title: "Receipt Print Logo",
    quickAccessDescription: "Quick access for the logo used on printed cashier and kitchen receipts.",
    openPrintSettings: "Open Print Settings",
    hardwareDescription: "Choose the logo that appears at the top of printed cashier and kitchen receipts.",
  },

  // Sentence is split around the bold inline <span> highlights in the JSX
  // (Manage Staff / "Waiter" / "Order Taker") rather than one long string.
  waiterMoved: {
    title: "Waiter Setup Has Moved",
    descriptionPart1: "Waiters and order takers are now added from",
    manageStaff: "Manage Staff",
    descriptionPart2: "Add a staff member there with designation",
    waiter: "Waiter",
    or: "or",
    orderTaker: "Order Taker",
    descriptionPart3: "and they'll automatically show up in the POS waiter dropdown.",
  },

  fields: {
    shopName: "Shop Name",
    shopNamePlaceholder: "Your shop's name",
    businessEmail: "Business Email",
    shopAddress: "Shop Address",
    shopAddressPlaceholder: "Your shop's address",
    businessStartTime: "Business Start Time",
    businessEndTime: "Business End Time",
    currency: "Currency",
    timezone: "Timezone",
    taxRate: "Tax Rate (%)",
  },

  devicePreferences: {
    title: "Device Preferences",
    dualScreenDisplay: {
      label: "Dual Screen Display",
      description: "Enable customer-facing checkout screen.",
    },
    autoPrintReceipts: {
      label: "Auto-print Receipts",
      description: "Print physical receipt after every transaction.",
    },
  },

  hardware: {
    devicePrintersTitle: "Device Printers",
    counterPrinter: "Counter Printer",
    selectCounterPrinter: "Select Counter Printer",
    kitchenPrinter: "Kitchen Printer",
    selectKitchenPrinter: "Select Kitchen Printer",
  },

  printLogoCard: {
    changeLogo: "Change Logo",
    selectLogo: "Select Logo",
    remove: "Remove",
    previewAlt: "Selected print logo preview",
    noLogo: "No Logo",
    selectedAsset: "Selected Asset",
    helpText: "Use a clean PNG, JPG, WEBP, or SVG. The logo is saved in this browser and will be used the next time you open the print center.",
    // Fallback labels for selectedLogoName (no logo yet / a data: URI just
    // uploaded / a stored path with no readable filename).
    noLogoSelected: "No logo selected",
    uploadedPrintLogo: "Uploaded print logo",
    selectedPrintLogoFallback: "Selected print logo",
  },

  toasts: {
    settingsSaved: "Settings saved.",
    syncFailed: "Settings saved, but the shop name/address failed to sync - check your connection and try again.",
  },
} as const;
