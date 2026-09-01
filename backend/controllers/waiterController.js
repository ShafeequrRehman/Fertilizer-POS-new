const User = require("../models/User");
const { shopScope } = require("../middleware/attachShopScope");

// Waiter names shown in POS order placement now come straight from the
// Manage Staff directory (User docs with role: "employee"), filtered to
// whichever designation is doing the "waiter" job at this shop - Waiter
// or Order Taker. There is no separate waiter-creation UI anymore (see
// EmployeesPage.tsx / SidebarPagesSection... actually SettingsPage.tsx -
// "Manage Staff" is the only place staff, including waiters, get added).
// Response shape is kept identical to the old Waiter-collection version
// ({ id, name, isActive }) so POSPage.tsx/EditOrderPage.tsx and their
// mobile equivalents need no changes.
const WAITER_DESIGNATIONS = ["waiter", "order taker"];

exports.getWaiters = async (req, res) => {
  const staff = await User.find({
    ...shopScope(req),
    role: "employee",
    designation: { $in: WAITER_DESIGNATIONS.map((d) => new RegExp(`^${d}$`, "i")) },
  }).sort({ name: 1 }).lean();

  res.json(
    staff.map((member) => ({
      id: String(member._id),
      name: member.name || member.username,
      isActive: member.isActive,
    }))
  );
};

// Same pattern as getWaiters above, but for "Delivery Rider" - the
// designation already offered in EmployeesPage.tsx's Manage Staff form
// (see src/lib/staff-designations.ts). Lets SalesPage.tsx's
// OnlineOrderControls build a real "assign this delivery to ___" picker
// from the shop's own staff directory, instead of the old flat
// Shop.riderPhones broadcast list (still used as a fallback - see
// orderController.assignRider) - phone is included here (unlike
// getWaiters, which never needed it) since that's what the WhatsApp
// notification is actually sent to.
exports.getRiders = async (req, res) => {
  const staff = await User.find({
    ...shopScope(req),
    role: "employee",
    designation: /^delivery rider$/i,
  }).sort({ name: 1 }).lean();

  res.json(
    staff.map((member) => ({
      id: String(member._id),
      name: member.name || member.username,
      phone: member.phone || "",
      isActive: member.isActive,
      // Directory details from the Manage Staff form (EmployeesPage.tsx) -
      // included here so the rider-assignment picker can show more than
      // just a name/phone if it ever wants to (e.g. vehicle number).
      vehicleNumber: member.vehicleNumber || "",
      idCardNumber: member.idCardNumber || "",
      address: member.address || "",
    }))
  );
};
