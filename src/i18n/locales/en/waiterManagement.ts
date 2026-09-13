// Waiter Directory management section (add/update/activate/remove
// waiters used for POS order attribution) - see
// src/components/WaiterManagementSection.tsx.
export const waiterManagement = {
  title: "Waiter Directory",
  description: "Add, update, activate, or remove waiters for this shop. The same list is used in POS order entry.",
  activeWaiters: "Active Waiters",

  namePlaceholder: "Enter waiter name",
  addWaiter: "Add Waiter",

  enterNameFirst: "Enter a waiter name first.",
  waiterAdded: 'Waiter "{{name}}" added.',
  failedToAdd: "Failed to add waiter.",

  nameCannotBeEmpty: "Waiter name cannot be empty.",
  waiterUpdated: 'Waiter "{{name}}" updated.',
  failedToUpdate: "Failed to update waiter.",

  waiterActivated: 'Waiter "{{name}}" activated.',
  waiterDeactivated: 'Waiter "{{name}}" deactivated.',
  failedToUpdateStatus: "Failed to update waiter status.",

  waiterDeleted: 'Waiter "{{name}}" deleted.',
  failedToDelete: "Failed to delete waiter.",
  failedToLoad: "Failed to load waiters.",

  loadingWaiters: "Loading waiters...",
  noWaitersSaved: "No waiters saved yet.",

  availableInPos: "Available in POS",
  hiddenFromPos: "Hidden from POS",

  activate: "Activate",
  deactivate: "Deactivate",
} as const;
