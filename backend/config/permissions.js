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
  // Narrower than inventory.manage - grants the Ingredient Stock page
  // (ingredients, categories, incoming purchases) WITHOUT Recipe
  // Management access. Introduced for the Stock Manager role (see
  // DEFAULT_ROLE_PRESETS below), whose whole job is tracking raw stock and
  // supplier dues, not defining how much of each ingredient a recipe uses.
  // Every route that already accepts inventory.manage for ingredient/
  // purchase access accepts this too (see middleware/requireAnyPermission.js
  // and its callers) - inventory.manage still covers everything stock.manage
  // does, for roles (Manager, Store Keeper) that should keep seeing both
  // Ingredient Stock and Recipe Management.
  { key: "stock.manage", label: "Manage Ingredient Stock", module: "Inventory", description: "Add ingredients/categories, log incoming purchases, and manage supplier records - without Recipe Management access." },
  { key: "customers.manage", label: "Manage Customers", module: "Customers", description: "Add, edit, and search customer records." },
  { key: "dues.manage", label: "Manage Customer Dues", module: "Customers", description: "Adjust and clear customer outstanding balances." },
  { key: "suppliers.manage", label: "Manage Suppliers", module: "Purchasing", description: "Add, edit, and manage supplier records." },
  { key: "purchases.manage", label: "Manage Purchases", module: "Purchasing", description: "Create and manage purchase orders." },
  { key: "expenses.manage", label: "Manage Expenses", module: "Accounting", description: "Record and manage shop expenses." },
  { key: "reports.view", label: "View Reports", module: "Reports", description: "View sales, inventory, and financial reports." },
  // Two narrow slices of "Reports" for roles that must never see
  // restaurant-wide revenue/COGS/net-profit figures (see
  // reportController.getMySalesReport / getInventoryReport, which return
  // only the data these keys authorize - not just a UI-hidden superset of
  // the full report). Independent of reports.view: a role can hold one,
  // both, or neither of these without ever gaining the full Day-End report.
  { key: "reports.view.own_sales", label: "View Own Sales Report", module: "Reports", description: "View only their own daily personal sales - no restaurant-wide analytics, cost, or profit figures." },
  { key: "reports.view.inventory", label: "View Inventory Reports", module: "Reports", description: "View kitchen stock purchase logs and supplier dues - no revenue or profit figures." },
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
  // Front-of-house only: POS + Sales + printing bills, and their own daily
  // sales figures - deliberately NOTHING else (no inventory, no customer/
  // dues management, no the full Reports page). See dashboard-pages.ts's
  // own comment on how this maps to sidebar visibility.
  Receptionist: ["sales.create", "sales.print", "reports.view.own_sales"],
  // Kitchen stock only: ingredients, categories, purchase logging, and
  // supplier records - deliberately NOT inventory.manage (which would also
  // unlock Recipe Management) and NOT purchases.manage (which would also
  // unlock the standalone Purchase page) - see requireAnyPermission.js's
  // callers for how stock.manage alone still covers real ingredient/
  // purchase actions.
  "Stock Manager": ["stock.manage", "suppliers.manage", "reports.view.inventory"],
};

module.exports = { PERMISSIONS, PERMISSION_KEYS, DEFAULT_ROLE_PRESETS };
