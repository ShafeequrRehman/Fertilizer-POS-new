const mongoose = require("mongoose");

// A single money-movement record between the shop and a staff member -
// what the Payroll page uses to compute "paid this month" / "remaining"
// on top of User.monthlySalary. Every row is scoped to both the shop and
// the employee, so a shop only ever sees its own staff's payments.
const staffPaymentSchema = new mongoose.Schema(
  {
    shopId: { type: mongoose.Schema.Types.ObjectId, ref: "Shop", required: true, index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    // salary: the regular monthly pay (or part of it) being disbursed.
    // advance: money taken by the employee ahead of payday.
    // bonus: extra pay on top of salary (doesn't reduce "remaining").
    // deduction: money owed back / withheld (e.g. correcting an overpayment).
    type: {
      type: String,
      enum: ["salary", "advance", "bonus", "deduction"],
      default: "salary",
    },
    note: { type: String, default: "" },
    date: { type: Date, default: Date.now },
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

staffPaymentSchema.index({ shopId: 1, employeeId: 1, date: -1 });

module.exports = mongoose.model("StaffPayment", staffPaymentSchema);
