const { getWhatsAppServiceForShop } = require("./whatsappService");

// Automated WhatsApp status updates sent straight to the CUSTOMER (not the
// rider/staff) at two points in a customer-qr (QR/online) order's
// lifecycle: staff confirming it (orderController.updateTrackingStatus)
// and it being fully completed/settled (orderController.updateOrder's
// completeAndSettle branch). Deliberately only ever called for
// `order.source === "customer-qr"` orders - a walk-in/staff-placed order
// already gets its own separate (Electron-only, PDF) receipt-on-WhatsApp
// flow client-side, so sending this too would double-message that
// customer. Mirrors riderNotificationService.js's shape: fire-and-forget,
// every failure caught internally, never throws back to the caller.

const WALKIN_PLACEHOLDER_PHONE = "03000000000";

function hasRealPhone(order) {
  const phone = order?.customer?.phone;
  return Boolean(phone && phone !== WALKIN_PLACEHOLDER_PHONE);
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("en-PK");
}

function formatDate(date) {
  return new Date(date || Date.now()).toLocaleString("en-PK", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatItems(items) {
  const lines = (items || []).map((item) => {
    const qty = Number(item.quantity) || 0;
    const lineTotal = formatMoney((Number(item.price) || 0) * qty);
    const variation = item.variation ? ` (${item.variation})` : "";
    return `- ${qty}x ${item.name}${variation} — Rs. ${lineTotal}`;
  });
  return lines.join("\n") || "-";
}

// No dedicated delivery-fee/service-charge field exists on Order yet - see
// orderController.recalculateTotals, `tax` is always 0 today but is the
// closest existing "extra line item" slot, so it doubles as "Other
// Charges" here rather than inventing a new field for this message alone.
function otherCharges(order) {
  return formatMoney(order.tax);
}

function orderNumberOf(order) {
  return order.dailyOrderNumber ?? String(order._id || "").slice(-6);
}

function buildOrderPlacedMessage(order, shop) {
  const shopName = shop?.name || "";
  return [
    `🛒 Order Placed`,
    `Hello ${order.customer?.name || "there"} 👋`,
    `Thank you for placing your order with ${shopName} ❤️`,
    `Your order has been successfully placed and is now being processed.`,
    `🧾 Order Details`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔖 Order No: ${orderNumberOf(order)}`,
    `📅 Date: ${formatDate(order.createdAt)}`,
    `🛍️ Items:`,
    formatItems(order.items),
    `💰 Subtotal: Rs. ${formatMoney(order.subtotal)}`,
    `🚚 Other Charges: Rs. ${otherCharges(order)}`,
    `💵 Order Total: Rs. ${formatMoney(order.total)}`,
    `💳 Payment Status: Pending`,
    `Amount: Rs. ${formatMoney(order.paidAmount)}`,
    `━━━━━━━━━━━━━━━━━━`,
    `📦 Order Status: 🟡 Processing`,
    `We appreciate your trust in ${shopName} and will keep you updated about your order.`,
    `🙏 Thank you for choosing us!`,
    `📞 ${shop?.phone || "-"}`,
    `📍 ${shop?.address || "-"}`,
    `❤️ ${shopName}`,
    `Quality • Trust • Service`,
  ].join("\n");
}

function buildOrderCompletedMessage(order, shop) {
  const shopName = shop?.name || "";
  const remaining = Number(order.remainingAmount || 0);
  const paymentStatus = remaining > 0 ? `⚠️ Rs. ${formatMoney(remaining)} Remaining` : `✅ Fully Paid`;
  return [
    `🎉 Order Completed`,
    `Hello ${order.customer?.name || "there"} 👋`,
    `Great news! 🎉`,
    `Your order from ${shopName} has been successfully completed.`,
    `🧾 Order Details`,
    `━━━━━━━━━━━━━━━━━━`,
    `🔖 Order No: ${orderNumberOf(order)}`,
    `📅 Date: ${formatDate(order.createdAt)}`,
    `🛍️ Items:`,
    formatItems(order.items),
    `💰 Subtotal: Rs. ${formatMoney(order.subtotal)}`,
    `🚚 Other Charges: Rs. ${otherCharges(order)}`,
    `💵 Total Amount: Rs. ${formatMoney(order.total)}`,
    `💳 Payment Details`,
    `Paid Amount: Rs. ${formatMoney(order.paidAmount)}`,
    paymentStatus,
    `━━━━━━━━━━━━━━━━━━`,
    `📦 Order Status: 🟢 Completed`,
    `🙏 Thank you so much for shopping with ${shopName}!`,
    `Your support means a lot to us. We look forward to serving you again. ❤️`,
    `📞 ${shop?.phone || "-"}`,
    `📍 ${shop?.address || "-"}`,
    `⭐ ${shopName}`,
    `Quality • Trust • Service`,
  ].join("\n");
}

async function sendCustomerMessage(order, shop, message) {
  if (!hasRealPhone(order) || !shop?._id) return false;
  try {
    const service = await getWhatsAppServiceForShop(shop._id);
    await service.sendMessage(order.customer.phone, message);
    return true;
  } catch (error) {
    console.error(`Non-fatal: customer WhatsApp notification failed for order ${order?._id}`, error.message);
    return false;
  }
}

async function notifyCustomerConfirmed(order, shop) {
  return sendCustomerMessage(order, shop, buildOrderPlacedMessage(order, shop));
}

async function notifyCustomerCompleted(order, shop) {
  return sendCustomerMessage(order, shop, buildOrderCompletedMessage(order, shop));
}

module.exports = {
  notifyCustomerConfirmed,
  notifyCustomerCompleted,
  buildOrderPlacedMessage,
  buildOrderCompletedMessage,
};
