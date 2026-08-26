const { getWhatsAppServiceForShop } = require("./whatsappService");

// Sends a Delivery order's customer/address details + a Google Maps link
// over WhatsApp, using the shop's own already-connected WhatsApp session
// (see whatsappService.js) - no separate rider app/login required. Two
// send paths share this one message builder:
//   - notifyRiderForDelivery: broadcasts to Shop.riderPhones (Settings ->
//     Customer Ordering) the moment a Delivery order auto/manually
//     confirms - the original, simpler "just a WhatsApp number" setup.
//   - notifyAssignedRider: targets ONE specific staff member (a User with
//     designation "Delivery Rider" - see waiterController.getRiders),
//     picked per-order from SalesPage.tsx's OnlineOrderControls once
//     staff know who's actually free to go. Both can be used together -
//     assigning a rider doesn't turn the broadcast off.
function buildRiderMessage(order, shop) {
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
  return lines.join("\n");
}

// Never throws - a missing rider number, a not-yet-connected WhatsApp
// session, or a send failure should never block confirming/assigning the
// order itself.
async function sendToPhones(order, shop, phones) {
  const unique = Array.from(new Set(phones.filter(Boolean)));
  if (unique.length === 0) return { sent: [], failed: [] };

  const message = buildRiderMessage(order, shop);
  const sent = [];
  const failed = [];
  try {
    const service = await getWhatsAppServiceForShop(shop._id);
    await Promise.all(
      unique.map((phone) =>
        service
          .sendMessage(phone, message)
          .then(() => sent.push(phone))
          .catch((error) => {
            console.error(`Non-fatal: WhatsApp rider notification failed for ${phone}`, error.message);
            failed.push(phone);
          })
      )
    );
  } catch (error) {
    console.error("Non-fatal: rider notification failed for order", order?._id, error.message);
    failed.push(...unique);
  }
  return { sent, failed };
}

async function notifyRiderForDelivery(order, shop) {
  const riderPhones = Array.isArray(shop?.riderPhones) ? shop.riderPhones : [];
  return sendToPhones(order, shop, riderPhones);
}

// riderPhone: the single phone number to notify (the staff member's own
// number - see Order.assignedRider). Returns whether it actually sent, so
// the assign-rider endpoint can tell staff "assigned, but couldn't reach
// them on WhatsApp" instead of silently pretending it worked.
async function notifyAssignedRider(order, shop, riderPhone) {
  const result = await sendToPhones(order, shop, [riderPhone]);
  return result.sent.includes(riderPhone);
}

module.exports = { notifyRiderForDelivery, notifyAssignedRider };
