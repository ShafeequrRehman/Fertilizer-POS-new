// ShopClosingSummaryModal.tsx - the day-end/shift closing summary modal
// (Total Revenue, Expenses Breakdown, Orders by Type, Outstanding Due,
// send-to-owner-on-WhatsApp, and the final Confirm & Close Shop action).
//
// The PDF-building helpers in that file (buildPdfStats/buildExpenseTable/
// buildOrderTypeTable/buildClosingPdfDoc) are deliberately left with their
// own plain English literals, NOT wired to t() here - ReportPdfDocument
// (src/lib/pdf-export.tsx) renders with a fixed Helvetica font that has no
// Urdu glyphs and no RTL shaping, so routing Urdu text through it would
// print as blank/garbled boxes on the actual receipt PDF.
export const shopClosingSummary = {
  header: {
    title: "Daily Day Closing & Z-Report",
    subtitle: "End of Day Financial Reconciliation",
  },

  loading: "Loading today's numbers...",
  loadError: "Couldn't load the closing summary.",

  stats: {
    totalRevenue: "Total Revenue",
    netProfit: "Net Profit",
    totalOrders: "Total Orders",
    outstandingDue: "Outstanding Due",
  },

  expensesBreakdown: {
    title: "Expenses Breakdown",
    kitchenStock: "Kitchen Stock (ingredient purchases)",
    manualOperations: "Manual Operations (other expenses)",
  },

  ordersByType: {
    title: "Orders by Type",
    dineIn: "Dine-In",
    takeaway: "Takeaway",
    delivery: "Delivery",
  },

  sendToOwner: {
    title: "Send To Owner",
    phonePlaceholder: "Owner's WhatsApp number",
  },

  printReceipt: "Print Receipt",
  sendWhatsapp: "Send WhatsApp",
  sending: "Sending...",
  confirmAndCloseShop: "Confirm & Close Shop",
  closingInProgress: "Closing...",

  toasts: {
    enterPhoneFirst: "Enter the owner's WhatsApp number first.",
    sentToWhatsapp: "Closing summary sent to owner on WhatsApp.",
    whatsappSendError: "Couldn't send WhatsApp message. Make sure WhatsApp is connected in Settings.",
  },
} as const;
