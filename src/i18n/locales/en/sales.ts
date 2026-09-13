// Sales page (order list, order detail panel, payment/cancel/add-items
// modals, online-order QR controls, receipt/kitchen auto-print status
// messages) - see src/pages/dashboard/sales/SalesPage.tsx.
export const sales = {
  searchPlaceholder: "Search orders, tables, customers, waiters - Enter to check out",
  orderImageAlt: "Order",

  stats: {
    pendingOrders: "Pending Orders",
    completed: "Completed",
    cancelled: "Cancelled",
    openValue: "Open Value",
  },

  shiftContext: {
    openShift: "Showing orders for the current open shift - not split by calendar date.",
    lastShift: "Showing orders for this shop's last shift - not split by calendar date.",
    noShiftRecorded: "No shift recorded yet. Open the shop to start taking orders.",
  },

  tabs: {
    pending: "Pending ({{count}})",
    completed: "Completed ({{count}})",
  },

  filters: {
    dineIn: "Dine In",
    takeAway: "Take Away",
    delivery: "Delivery",
  },

  loadingOrders: "Loading orders...",
  noPendingOrdersFiltered: "No pending orders matched the current filters.",
  noCompletedOrdersFiltered: "No completed orders matched the current filters.",

  onlineWaitingAcceptance: "Online - Waiting Acceptance",
  onlineStatusPrefix: "Online - {{status}}",
  changeRequestedBadge: "Change Requested",

  orderNumberHeading: "Order #{{number}}",
  tableLabel: "Table {{table}}",
  orderTypeItemsCount: "{{type}} • {{count}} items",
  loadMore: "Load More ({{count}} more)",

  orderDetailLabel: "Order Detail",
  loadingFullOrderDetails: "Loading full order details...",
  sendingEllipsis: "Sending...",
  sendToKitchen: "Send to Kitchen",
  printReceipt: "Print Receipt",
  editLocked: "Edit Locked",

  boxLabels: {
    orderNumber: "Order Number",
    createdAt: "Created At",
    customer: "Customer",
    waiter: "Waiter",
    table: "Table",
    orderType: "Order Type",
    paymentMethod: "Payment Method",
    deliveryLocation: "Delivery Location",
    previousDues: "Previous Dues",
    remaining: "Remaining",
    note: "Note",
    billTid: "TID",
    billName: "Bill Name",
    cashRecipientName: "Cash Given To",
  },

  notApplicable: "N/A",
  notShared: "Not shared",
  openInMaps: "Open in Maps",

  items: "Items",
  addItems: "Add Items",
  orderLocked: "Order Locked",
  loadingItems: "Loading items...",
  qty: "Qty {{quantity}}",

  billSummary: {
    subtotal: "Subtotal",
    tax: "Tax",
    billTotal: "Bill Total",
    paid: "Paid",
    grandTotal: "Grand Total",
    finalPayable: "Final Payable",
    discountPercent: "Discount ({{value}}% - Percentage)",
    discountFixed: "Discount (Fixed Value)",
  },

  completeOrder: "Complete Order",
  cancelOrder: "Cancel Order",
  orderCancelledKept: "This order was cancelled and kept for record.",
  cancelledBy: "Cancelled by {{name}}",
  reasonLabel: "Reason: {{reason}}",
  orderCompletedStored: "This order is completed and stored in sales history.",

  selectOrderTitle: "Select an order",
  selectOrderHint: "Choose any order card from the left.",

  completePaymentTitle: "Complete Payment",
  amountPaidLabel: "Amount Paid / Cash Received",
  billPlaceholder: "Bill is Rs {{payable}} - enter cash received",
  changeReturnLabel: "Change Return / Balance Due Back",
  putInPending: "Put in Pending - confirm with no payment collected right now (this leaves the full ₨{{payable}} as a due).",
  confirmPaymentButton: "Confirm Payment",
  payFull: "Pay Full",

  addItemsToOrderTitle: "Add Items To Order",
  autoPrintFrameTitle: "Auto Print Frame",

  loginTokenMissing: "Login token not found. Sales updates will not sync to MongoDB until you log in again.",
  localHubUnreachable: "Couldn't reach this till's own Local Hub{{reason}} - restart the app to enable offline order history.",
  failedToStart: "failed to start",

  orderNotInLocalCache: "This order isn't in this till's local cache - try again once back online.",
  couldNotRefreshOffline: "Couldn't refresh this order offline.",
  couldNotRefreshOrder: "Could not refresh this order.",
  noPendingOrderFound: "No pending order found matching \"{{query}}\".",

  savedKitchenPrintedSyncing: "Saved - kitchen ticket printed. Syncing to the cloud...",
  savedKitchenPrintedOffline: "Saved - kitchen ticket printed. Will sync once back online.",
  savedSyncingToCloud: "Saved - syncing to the cloud...",
  savedWillSyncOffline: "Saved - will sync once back online.",
  couldNotSaveChange: "Could not save this change.",

  invalidPaymentAmountTitle: "Invalid Payment Amount",
  enterValidPaymentAmount: "Enter a valid payment amount.",
  paymentAmountRequiredTitle: "Payment Amount Required",
  paymentAmountRequiredMessage: "Enter a payment amount, or check \"Put in Pending\" to confirm this order with no payment collected.",

  zeroPaymentCustomerRequired: "Add the customer's name and phone number before confirming with zero payment - the full amount becomes a due, and dues need a real customer to track them against. Edit the order first, or pay in full instead.",
  partialPaymentCustomerRequired: "Add the customer's name and phone number before confirming a partial payment - dues need a real customer to track them against. Edit the order first, or pay in full instead.",

  confirmZeroPaymentTitle: "Confirm Zero Payment",
  confirmZeroPaymentMessage: "No payment will be collected right now for Order #{{orderNumber}} - the full ₨{{payable}} will be recorded as a due against {{customerName}}. Continue?",

  orderCompletedChange: "Order #{{orderNumber}} completed - Rs {{paid}} collected, Rs {{change}} change returned.",
  orderCompletedNoChange: "Order #{{orderNumber}} completed - Rs {{paid}} collected.",

  whatsappReceiptSendFailed: "Order completed, but WhatsApp PDF receipt could not be sent.",
  orderCancelledSuccessfully: "Order {{orderId}} cancelled successfully.",
  declineOnlineOrderConfirm: "Decline/cancel this online order?",
  orderMarkedStatus: "Order #{{orderId}} marked {{status}}.",
  couldNotUpdateOrder: "Could not update this order.",

  assignedRiderNotified: "Assigned to {{name}} - WhatsApp sent.",
  assignedRiderNotNotified: "Assigned to {{name}}, but the WhatsApp message could not be sent.",
  couldNotAssignRider: "Could not assign this rider.",

  changeRequestApproved: "Change request approved - order updated.",
  changeRequestDeclined: "Change request declined.",
  couldNotRespondToRequest: "Could not respond to this request.",

  selectAtLeastOneItem: "Select at least one item.",

  addedItemsSyncing: "Added {{count}} item(s) to {{orderId}}. Syncing to the cloud...",
  addedItemsOffline: "Added {{count}} item(s) to {{orderId}}. Will sync once back online.",
  addedItemsPlain: "Added {{count}} item(s) to {{orderId}}.",

  whatsappNeedsInternet: "WhatsApp needs an internet connection - try again once back online.",
  noValidPhoneNumber: "No valid phone number for this customer.",
  customerReceiptLabel: "Customer receipt",
  receiptSentWhatsApp: "Receipt sent via WhatsApp to {{phone}}",
  whatsappSendFailed: "Failed to send WhatsApp message. Is it connected?",
  whatsappSendFailedPrefix: "WhatsApp send failed: ",

  whatsappOrderNo: "Order No: *{{number}}*",
  whatsappTotal: "Total: *PKR {{total}}*",
  whatsappThankYou: "Thank you for your order!",

  customer: {
    dineInCustomer: "Dine-In Customer",
    walkInCustomer: "Walk-in Customer",
    waiterPrefix: "Waiter: {{name}}",
    noPhone: "No phone",
  },

  minAgo: "{{mins}} min ago",
  hrMinAgo: "{{hr}} hr {{min}} min ago",
  dayAgo: "{{days}} Day ago",
  daysAgo: "{{days}} Days ago",

  tableTypeTitle: "Table {{table}} - {{type}}",
  familyTable: "Family Table",
  simpleTable: "Simple Table",

  tracking: {
    awaitingConfirmation: "Waiting for confirmation",
    confirmed: "Confirmed",
    preparing: "Preparing",
    ready: "Ready",
    cancelled: "Cancelled",
  },

  orderStatus: {
    pending: "pending",
    completed: "completed",
    paid: "paid",
    cancelled: "cancelled",
  },

  online: {
    orderLabel: "Online Order",
    paymentStatusLabel: "Payment: {{status}}",
    markStatus: "Mark {{status}}",
    decline: "Decline",
    deliveryRider: "Delivery Rider",
    assignedTo: "Assigned to {{name}}",
    notAssignedYet: "Not assigned yet.",
    noRidersOnStaff: "No riders on staff",
    chooseRider: "Choose a rider…",
    reassignNotify: "Reassign & Notify",
    assignNotify: "Assign & Notify",
    customerRequestedChange: "Customer Requested a Change",
    approve: "Approve",
  },
} as const;
