// Canonical catalog of permission keys used throughout the app.
//
// - Super Admin bypasses this catalog entirely (has every capability).
// - Shop Owner bypasses this catalog entirely within their own shop (has
//   every capability listed here, always - a Shop Owner can never be
//   locked out of their own shop's data).
// - Employees are granted a subset of these keys via their assigned Role
//   (models/Role.js). requirePermission(key) middleware checks this.
//
// Keep `module` values stable - the Super Admin and Shop Owner frontends
// group the permission-picker UI by this field.
const PERMISSIONS = [
  { key: "sales.create", label: "Create Sales", module: "Sales", description: "Ring up new orders at the POS screen." },
  { key: "sales.edit", label: "Edit Sales", module: "Sales", description: "Edit pending orders (add items, change details)." },
  { key: "sales.delete", label: "Delete / Cancel Sales", module: "Sales", description: "Cancel pending orders." },
  { key: "sales.refund", label: "Refund Sales", module: "Sales", description: "Process refunds on completed orders." },
  { key: "sales.print", label: "Print Bills", module: "Sales", description: "Print or reprint customer and kitchen receipts." },
  { key: "inventory.manage", label: "Manage Inventory", module: "Inventory", description: "Add, edit, and manage products, categories, and stock levels." },
  { key: "customers.manage", label: "Manage Customers", module: "Customers", description: "Add, edit, and search customer records." },
  { key: "dues.manage", label: "Manage Customer Dues", module: "Customers", description: "Adjust and clear customer outstanding balances." },
  { key: "suppliers.manage", label: "Manage Suppliers", module: "Purchasing", description: "Add, edit, and manage supplier records." },
  { key: "purchases.manage", label: "Manage Purchases", module: "Purchasing", description: "Create and manage purchase orders." },
  { key: "expenses.manage", label: "Manage Expenses", module: "Accounting", description: "Record and manage shop expenses." },
  { key: "reports.view", label: "View Reports", module: "Reports", description: "View sales, inventory, and financial reports." },
  { key: "employees.manage", label: "Manage Employees", module: "Employees", description: "Create, edit, and remove employee accounts and roles." },
  { key: "settings.manage", label: "Manage Settings", module: "Settings", description: "Change shop profile, receipt, and hardware settings." },
  { key: "whatsapp.manage", label: "Manage WhatsApp", module: "Settings", description: "Connect WhatsApp and send messages to customers." },
  { key: "shop.session.manage", label: "Open / Close Shop", module: "Sales", description: "Open the shop to start taking orders, and close it at end of day to lock in the shift's order count and totals." },
  { key: "orders.record.view", label: "View Daily Record", module: "Sales", description: "View the full list of every order (pending, completed, paid, cancelled) placed during the current shift." },
];

const PERMISSION_KEYS = PERMISSIONS.map((permission) => permission.key);

// Sensible starting permission sets for the default roles the migration /
// shop-creation flow seeds automatically. Shop owners can freely edit or
// delete these afterward - they are not hardcoded elsewhere.
const DEFAULT_ROLE_PRESETS = {
  Cashier: ["sales.create", "sales.print", "customers.manage"],
  Manager: [
    "sales.create", "sales.edit", "sales.delete", "sales.refund", "sales.print",
    "inventory.manage", "customers.manage", "dues.manage", "reports.view", "shop.session.manage",
    "orders.record.view",
  ],
  Accountant: ["reports.view", "expenses.manage", "purchases.manage", "dues.manage"],
  "Store Keeper": ["inventory.manage", "suppliers.manage", "purchases.manage"],
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, DEFAULT_ROLE_PRESETS };
