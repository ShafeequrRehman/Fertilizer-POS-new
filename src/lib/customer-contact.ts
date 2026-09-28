// Customer Dues' "Add Customer" form no longer requires a phone number
// (backend/models/Customer.js's own comment on why) - a shop owner can
// track dues for someone whose number they don't have. Every OTHER part
// of this app (updateCustomerDues/settleCustomerDues/deleteDuesHistoryEntry/
// getCustomerOutstanding - all keyed by :phone in the URL, not by
// Customer._id) still needs a real, non-empty, unique string to key off
// of though, so a customer left blank at creation gets one of these
// synthetic placeholders instead of a genuinely empty string - every
// phone-keyed route keeps working completely unchanged, and the rest of
// the app (WhatsApp Remind/Send PDF, the phone shown on this customer's
// card) just needs to recognize this shape and treat it as "no real
// phone" rather than actually trying to use it as one.
//
// Deliberately ALL LETTERS, never a single digit - WhatsApp's own
// normalizePhone (backend/services/whatsappService.js) strips everything
// but digits before sending, so a placeholder that happened to contain
// digits could, in the worst case, silently resolve to some real
// stranger's WhatsApp number. A pure-letters placeholder always fails
// normalizePhone's own check instead (belt-and-braces - the actual
// guard is hasRealPhone below, checked BEFORE ever calling the WhatsApp
// API, so normalizePhone should never even see one of these).
export const PLACEHOLDER_PHONE_PREFIX = 'NOPHONE-';

export function generatePlaceholderPhone(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 12; i += 1) {
    suffix += letters[Math.floor(Math.random() * letters.length)];
  }
  return `${PLACEHOLDER_PHONE_PREFIX}${suffix}`;
}

export function hasRealPhone(phone: string | null | undefined): boolean {
  return Boolean(phone && phone.trim() && !phone.startsWith(PLACEHOLDER_PHONE_PREFIX));
}
