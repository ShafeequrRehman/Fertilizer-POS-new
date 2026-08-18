const Expense = require("../models/Expense");
const { shopScope } = require("../middleware/attachShopScope");

exports.getExpenses = async (req, res) => {
  const expenses = await Expense.find({ ...shopScope(req) }).sort({ date: -1 }).lean();
  res.json(expenses);
};

exports.getExpense = async (req, res) => {
  const expense = await Expense.findOne({ _id: req.params.id, ...shopScope(req) });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.json(expense);
};

exports.createExpense = async (req, res) => {
  const { shopId, ...body } = req.body;
  const expense = await Expense.create({
    ...body,
    shopId: req.user.shopId,
    recordedBy: req.user.id,
  });
  res.status(201).json(expense);
};

exports.updateExpense = async (req, res) => {
  const { shopId, recordedBy, ...updates } = req.body;
  const expense = await Expense.findOneAndUpdate({ _id: req.params.id, ...shopScope(req) }, updates, { new: true });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.json(expense);
};

exports.deleteExpense = async (req, res) => {
  const expense = await Expense.findOneAndDelete({ _id: req.params.id, ...shopScope(req) });
  if (!expense) return res.status(404).json({ error: "Expense not found" });
  res.status(204).send();
};
