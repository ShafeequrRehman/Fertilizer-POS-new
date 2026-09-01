// Common job titles offered in the Manage Staff form. Designation is
// stored as free text on the backend (see backend/models/User.js), so a
// shop can still type a custom one - this list just saves typing for the
// common cases. "Waiter" and "Order Taker" are the two designations
// waiterController.getWaiters looks for when building the POS waiter
// dropdown, so keep those two spellings in sync with the backend if this
// list ever changes.
export const STAFF_DESIGNATIONS = [
  "Chief",
  "Manager",
  "Cashier",
  "Order Taker",
  "Waiter",
  "Cook",
  "Helper",
  "Delivery Rider",
  "Cleaner",
  "Security",
] as const;
