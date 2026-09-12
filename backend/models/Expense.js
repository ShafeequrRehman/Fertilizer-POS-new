const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now },
    note: { type: String, default: "" },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // Employee Expenses (meals/food, etc.) - optional, so every pre-existing
    // expense (and every other category that has nothing to do with a
    // specific staff member - rent, utilities, waste...) keeps working
    // completely unchanged with this left null. When set, this expense
    // shows up on that employee's own Payroll history view (see
    // PayrollPage.tsx) IN ADDITION to the normal category-based reporting -
    // it's still a perfectly ordinary Expense row everywhere else
    // (getDayEndReport's otherExpenses/expenseBreakdown, the Reports page
    // list), just also attributable to a person. Deliberately NOT
    // subtracted from that employee's remaining salary anywhere - see
    // shopOwnerController.js's payroll comment on why salary math only ever
    // reads from StaffPayment, never from Expense.
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Expense", expenseSchema);
