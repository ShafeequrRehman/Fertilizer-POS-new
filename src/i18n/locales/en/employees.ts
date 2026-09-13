// Manage Staff page (Employees tab + Roles & Permissions tab) - see
// src/pages/dashboard/EmployeesPage.tsx. Covers the staff list table, the
// staff details/create/edit modals, password reset, role editor, and the
// per-employee permission-override modal.
export const employees = {
  title: "Manage Staff",
  offlineBadge: "Offline — changes will sync automatically",
  subtitle: "Staff accounts, designations, directory details, and the roles that control what they can see and do.",
  newStaffMember: "New Staff Member",
  newRole: "New Role",

  tabs: {
    staff: "Staff",
    rolesPermissions: "Roles & Permissions",
  },

  table: {
    designation: "Designation",
    username: "Username",
    role: "Role",
    noStaffYet: "No staff members yet.",
  },

  actions: {
    viewFullDetails: "View full details",
    editStaffDetails: "Edit staff details",
    grantRevokePermissions: "Grant or revoke individual permissions",
    resetPassword: "Reset password",
    remove: "Remove",
  },

  confirmRemoveTitle: "Remove staff member",
  confirmRemoveMessage: 'Remove staff member "{{name}}"?',
  removeButton: "Remove",
  staffRemoved: '"{{name}}" removed.',
  couldNotLoadStaffLocalHub: "Could not load staff - Local Hub unreachable.",
  failedToLoadStaff: "Failed to load staff.",

  roles: {
    confirmDeleteTitle: "Delete role",
    confirmDeleteMessage: 'Delete role "{{name}}"?',
    deleted: 'Role "{{name}}" deleted.',
    failedToDelete: "Failed to delete role",
    hidesDashboardBadge: "Hides Dashboard",
    noPermissionsAssigned: "No permissions assigned",
  },

  fields: {
    fullName: "Full Name",
    username: "Username",
    designation: "Designation",
    role: "Role",
    email: "Email",
    phoneNumber: "Phone Number",
    idCardNumber: "ID Card Number",
    address: "Address",
    vehicleNumber: "Vehicle / Bike Number",
    reference: "Reference",
    monthlySalary: "Monthly Salary",
    comment: "Comment",
  },

  details: {
    title: "Staff Details — {{name}}",
    editDetails: "Edit Details",
  },

  form: {
    titleEdit: "Edit Staff — {{name}}",
    resetPasswordHint: 'Use "Reset password" to change the password.',
    password: "Password",
    emailOptional: "Email (optional)",
    roleSelectLabel: "Role (permissions)",
    selectRole: "Select a role",
    designationLabel: "Designation (job title - Waiter/Order Taker show up in the POS waiter list)",
    customDesignationPlaceholder: "e.g. Barista",
    chooseFromList: "Choose from list",
    selectDesignation: "Select a designation",
    otherCustom: "Other (type custom)…",
    saveChanges: "Save Changes",
    createStaffMember: "Create Staff Member",
    failedToUpdate: "Failed to update staff member",
    failedToCreate: "Failed to create staff member",
  },

  resetPasswordModal: {
    doneTitle: "Password Reset",
    passwordUpdatedMessage: "The staff member's password has been updated.",
    done: "Done",
    title: "Reset Password — {{name}}",
    newPasswordLabel: "New Password",
    failedToReset: "Failed to reset password",
    resetPasswordButton: "Reset Password",
  },

  roleEditor: {
    titleEdit: "Edit Role — {{name}}",
    roleNameLabel: "Role Name",
    hideDashboardLabel: "Hide Dashboard",
    hideDashboardDescription: "Staff with this role won't see or be able to open the main Dashboard home page after logging in - they land on their first available page instead.",
    failedToSave: "Failed to save role",
    saveRole: "Save Role",
  },

  permissionsModal: {
    title: "Permissions — {{name}}",
    description: "Starts from this account's role. Check a box to grant that permission to {{name}} specifically; uncheck one their role would otherwise grant to take it away - just for this account.",
    updated: 'Permissions updated for "{{name}}".',
    failedToSave: "Failed to save permissions",
    added: "Added",
    removed: "Removed",
    roleDefault: "Role default",
    savePermissions: "Save Permissions",
  },
} as const;
