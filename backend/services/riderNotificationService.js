const { getWhatsAppServiceForShop } = require("./whatsappService");

// Sends the shop's configured rider(s) a WhatsApp message with a Delivery
// order's customer/address details and a Google Maps link, using the
// shop's own already-connected WhatsApp session (see whatsappService.js) -
// the same connection the shop already uses to send customers their
// receipts, no separate rider app/login required (see the
// AskUserQuestion answer this was built from: "WhatsApp message to a
// rider number"). Shared between orderController.js's manual
// updateTrackingStatus confirm action and publicOrderController.js's
// automatic payment-callback confirm - both need the exact same
// notification. Never throws - a missing rider number, a not-yet-connected
// WhatsApp session, or a send failure should never block confirming the
// order itself.
async function notifyRiderForDelivery(order, shop) {
  try {
    const riderPhones = Array.isArray(shop?.riderPhones) ? shop.riderPhones.filter(Boolean) : [];
    if (riderPhones.length === 0) return;

    const loc = order.deliveryLocation;
    const mapsLink =
      loc && typeof loc.lat === "number" && typeof loc.lng === "number"
        ? `https://maps.google.com/?q=${loc.lat},${loc.lng}`
        : order.customer?.address
        ? `https://maps.google.com/?q=${encodeURIComponent(order.customer.address)}`
        : null;

    const lines = [
      `New Delivery Order #${order.dailyOrderNumber} - ${shop?.name || ""}`.trim(),
      `Customer: ${order.customer?.name || "-"}`,
      `Phone: ${order.customer?.phone || "-"}`,
      `Address: ${order.customer?.address || order.address || "-"}`,
      `Total: Rs ${Number(order.total || 0).toFixed(0)}`,
    ];
    if (mapsLink) lines.push(`Location: ${mapsLink}`);
    const message = lines.join("\n");

    const service = await getWhatsAppServiceForShop(shop._id);
    await Promise.all(
      riderPhones.map((phone) =>
        service.sendMessage(phone, message).catch((error) => {
          console.error(`Non-fatal: WhatsApp rider notification failed for ${phone}`, error.message);
        })
      )
    );
  } catch (error) {
    console.error("Non-fatal: rider notification failed for order", order?._id, error.message);
  }
}

module.exports = { notifyRiderForDelivery };
