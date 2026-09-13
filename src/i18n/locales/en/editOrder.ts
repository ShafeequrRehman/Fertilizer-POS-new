// Edit Order page (editing a pending order's items/details before it's
// sent to the kitchen) - see
// src/pages/dashboard/sales/EditOrderPage.tsx.
export const editOrder = {
  loadingOrderEditor: "Loading order editor...",
  offlineUnavailable:
    "This order isn't in this till's local cache yet (it's either older than the 14-day offline cache window, or this till hasn't synced since it was placed). Use the order card's Add Items / Complete Payment instead, or try again once back online.",
  orderNotFound: "Order not found.",

  backToSales: "Back to Sales",
  pageTitle: "Edit Order #{{orderNumber}}",
  printCenter: "Print Center",
  saveChanges: "Save Changes",

  orderItems: "Order Items",
  orderMeta: "Order Meta",

  customerNamePlaceholder: "Customer name",
  phonePlaceholder: "Phone",
  searchingCustomers: "Searching customers...",
  duePrefix: "Due PKR {{amount}}",
  addressPlaceholder: "Address",
  waiterPlaceholder: "Waiter",
  tablePlaceholder: "Table",
  orderNotePlaceholder: "Order note",

  quickAddProduct: "Quick Add Product",
  searchMenuItemsPlaceholder: "Search menu items",
  priceDisplay: "Rs {{price}}",
  addCustomItem: "Add Custom Item",
  customItemDefaultName: "Custom Item",

  couldNotSaveChange: "Could not save this change.",
  orderSavedSyncing: "Order {{orderId}} saved. Syncing to the cloud...",
  orderSavedOffline: "Order {{orderId}} saved. Will sync once back online.",
  orderSavedSuccessfully: "Order {{orderId}} saved successfully.",
} as const;
