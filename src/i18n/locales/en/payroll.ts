// Payroll page (Shop-Owner-only: staff pay summary table, this-month
// payments log, record-payment modal, per-employee salary-history modal
// with its separate Employee Meals section) - see
// src/pages/dashboard/PayrollPage.tsx.
export const payroll = {
  title: "Payroll",
  subtitle: "What each staff member is owed, has taken, and has left for the month.",

  summary: {
    totalMonthlyPayroll: "Total Monthly Payroll",
    totalMonthlyPayrollHint: "Sum of every staff member's monthly salary",
    paidSoFarThisMonth: "Paid So Far This Month",
    paidSoFarThisMonthHint: "Salary + advances, minus deductions",
    remainingToPay: "Remaining To Pay",
    acrossStaffMember: "Across {{count}} staff member",
    acrossStaffMembers: "Across {{count}} staff members",
  },

  table: {
    staffPaySummary: "Staff Pay Summary",
    staffMember: "Staff Member",
    designation: "Designation",
    monthlySalary: "Monthly Salary",
    takenThisMonth: "Taken This Month",
    remaining: "Remaining",
    noStaffYet: "No staff members yet. Add them from Manage Staff.",
    bonusSuffix: "+Rs {{amount}} bonus",
    statusOverpaid: "overpaid",
    statusSettled: "settled",
    statusLeft: "left",
    history: "History",
    recordPayment: "Record Payment",
    loadMore: "Load More ({{count}} more)",
  },

  transactions: {
    heading: "Payments This Month",
    type: "Type",
    amount: "Amount",
    note: "Note",
    noneThisMonth: "No payments recorded this month yet.",
    loadMore: "Load More ({{count}} more)",
  },

  types: {
    salary: "Salary",
    advance: "Advance",
    bonus: "Bonus",
    deduction: "Deduction",
  },

  toasts: {
    mealLogged: "Meal expense logged.",
    paymentRecorded: "Payment recorded.",
  },

  recordModal: {
    enterValidAmount: "Enter a valid amount.",
    failedToRecordPayment: "Failed to record payment",
    title: "Record Payment",
    remainingThisMonth: "{{name}} · Rs {{amount}} remaining this month",
    typeLabel: "Type",
    amountLabel: "Amount",
    noteLabel: "Note (optional)",
    notePlaceholder: "e.g. mid-month advance",
    savePayment: "Save Payment",
  },

  historyModal: {
    salaryHistoryTitle: "{{name}}'s Salary History",
    monthUsername: "{{month}} · @{{username}}",
    monthlySalary: "Monthly Salary",
    paidThisMonth: "Paid This Month",
    bonus: "Bonus",
    remaining: "Remaining",
    overpaidSuffix: " (overpaid)",
    paymentHistory: "Payment History",
    noPaymentsThisMonth: "No payments recorded this month.",
    mealsThisMonth: "Employee Meals This Month",
    mealsHint: "Shown for reference only - not deducted from this employee's salary.",
    mealAmountPlaceholder: "Amount",
    mealNotePlaceholder: "Note (e.g. lunch)",
    logMeal: "Log Meal",
  },
} as const;
