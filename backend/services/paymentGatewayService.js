const crypto = require("crypto");

// JazzCash + EasyPaisa "Hosted Checkout" integration scaffold.
//
// IMPORTANT - read before going live: both gateways' exact field names,
// checkout URLs, and hash formats are only ever fully confirmed in the
// merchant onboarding packet each provider emails after approving a
// merchant account (they occasionally vary slightly by integration type -
// Hosted Checkout Page vs direct Mobile Wallet API vs OTC). Everything
// below is built against the field set and hash algorithm that's been
// stable and consistently documented across JazzCash/EasyPaisa's own
// sandbox docs and every third-party integration guide for years, but it
// has NOT been tested against a live merchant account (this shop doesn't
// have one yet - see Shop.paymentGateway, blank by default). Before
// switching a shop's environment from "sandbox" to "live", re-check this
// file's CHECKOUT_URLS and the two build*Payload functions against that
// shop's actual onboarding packet.
//
// Both flows are the same shape: buildXCheckoutPayload() returns a
// {url, fields} pair - fields is a plain object meant to be posted as a
// hidden auto-submitting HTML form (see CustomerOrderPage.tsx's
// PaymentRedirectForm) that sends the customer's browser to the gateway's
// own hosted page. The gateway later calls back publicOrderRoutes.js's
// payment-callback endpoint (or redirects the browser back with the same
// fields) - verifyXCallback() recomputes the hash server-side and never
// trusts the callback's own claimed success flag alone.

const CHECKOUT_URLS = {
  jazzCash: {
    sandbox: process.env.JAZZCASH_SANDBOX_URL || "https://sandbox.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/",
    live: process.env.JAZZCASH_LIVE_URL || "https://payments.jazzcash.com.pk/CustomerPortal/transactionmanagement/merchantform/",
  },
  easyPaisa: {
    sandbox: process.env.EASYPAISA_SANDBOX_URL || "https://easypaystg.easypaisa.com.pk/easypay/Index.jsf",
    live: process.env.EASYPAISA_LIVE_URL || "https://easypay.easypaisa.com.pk/easypay/Index.jsf",
  },
};

function pad(n) {
  return String(n).padStart(2, "0");
}

// JazzCash wants pp_TxnDateTime / pp_TxnExpiryDateTime as yyyyMMddHHmmss,
// local (Pakistan) time - matches every sample request in the sandbox docs.
function jazzCashTimestamp(date) {
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function isJazzCashConfigured(config) {
  return Boolean(config?.merchantId && config?.password && config?.integritySalt);
}

function isEasyPaisaConfigured(config) {
  return Boolean(config?.storeId && config?.hashKey);
}

// Standard JazzCash secure-hash algorithm: sort every pp_ field's VALUE
// (not key=value, just the value) by key name alphabetically, join with
// '&', prepend the Integrity Salt, HMAC-SHA256 the whole string using the
// Integrity Salt as the key, hex digest.
function jazzCashSecureHash(fields, integritySalt) {
  const sortedKeys = Object.keys(fields)
    .filter((key) => key.startsWith("pp_") && key !== "pp_SecureHash" && fields[key] !== undefined && fields[key] !== null)
    .sort();
  const joined = sortedKeys.map((key) => String(fields[key])).join("&");
  const message = `${integritySalt}&${joined}`;
  return crypto.createHmac("sha256", integritySalt).update(message).digest("hex");
}

// order: the Mongoose Order doc (or plain object) being paid for.
// config: shop.paymentGateway.jazzCash ({merchantId, password, integritySalt, environment}).
// returnUrl: where JazzCash sends the customer's browser back to after payment.
function buildJazzCashCheckoutPayload(order, config, returnUrl) {
  if (!isJazzCashConfigured(config)) {
    throw Object.assign(new Error("JazzCash isn't configured for this shop yet."), { status: 409, reason: "gateway_not_configured" });
  }
  const now = new Date();
  const expiry = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour to complete payment
  const amountInPaisa = String(Math.round(Number(order.total) * 100)); // JazzCash amount is in paisa (2 implied decimals)
  const txnRefNo = `T${order._id}`.slice(0, 20);

  const fields = {
    pp_Version: "1.1",
    pp_TxnType: "MWALLET",
    pp_Language: "EN",
    pp_MerchantID: config.merchantId,
    pp_Password: config.password,
    pp_TxnRefNo: txnRefNo,
    pp_Amount: amountInPaisa,
    pp_TxnCurrency: "PKR",
    pp_TxnDateTime: jazzCashTimestamp(now),
    pp_TxnExpiryDateTime: jazzCashTimestamp(expiry),
    pp_BillReference: `Order${order.dailyOrderNumber || ""}`,
    pp_Description: `Order #${order.dailyOrderNumber || ""}`,
    pp_ReturnURL: returnUrl,
    pp_BankID: "",
    pp_ProductID: "",
  };
  fields.pp_SecureHash = jazzCashSecureHash(fields, config.integritySalt);

  const environment = config.environment === "live" ? "live" : "sandbox";
  return { url: CHECKOUT_URLS.jazzCash[environment], fields, txnRefNo };
}

function verifyJazzCashCallback(fields, config) {
  if (!isJazzCashConfigured(config) || !fields?.pp_SecureHash) return { verified: false };
  const expected = jazzCashSecureHash(fields, config.integritySalt);
  const verified = expected === fields.pp_SecureHash;
  const success = verified && String(fields.pp_ResponseCode) === "000";
  return { verified, success, txnRefNo: fields.pp_TxnRefNo, transactionId: fields.pp_RetreivalReferenceNo || fields.pp_TxnRefNo };
}

// EasyPaisa Hosted Checkout ("easypay") hash: sort every field (excluding
// the hash itself) by key name, join as key=value pairs with '&',
// HMAC-SHA256 with the shop's Hash Key, base64-encoded - matches the
// documented "encryptedHashRequest" convention used by every EasyPaisa
// hosted-checkout sample.
function easyPaisaHash(fields, hashKey) {
  const sortedKeys = Object.keys(fields)
    .filter((key) => key !== "encryptedHashRequest" && fields[key] !== undefined && fields[key] !== null && fields[key] !== "")
    .sort();
  const joined = sortedKeys.map((key) => `${key}=${fields[key]}`).join("&");
  return crypto.createHmac("sha256", hashKey).update(joined).digest("base64");
}

function easyPaisaTimestamp(date) {
  return (
    date.getFullYear().toString() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function buildEasyPaisaCheckoutPayload(order, config, postBackUrl) {
  if (!isEasyPaisaConfigured(config)) {
    throw Object.assign(new Error("EasyPaisa isn't configured for this shop yet."), { status: 409, reason: "gateway_not_configured" });
  }
  // "Last two digits are decimal" - i.e. no decimal point, amount * 100.
  const amount = (Number(order.total) * 100).toFixed(0);
  const orderRefNum = `T${order._id}`.slice(0, 20); // max 20 alphanumeric

  const fields = {
    amount,
    orderRefNum,
    paymentMethod: "InitialRequest",
    postBackURL: postBackUrl,
    storeId: config.storeId,
    timeStamp: easyPaisaTimestamp(new Date()),
  };
  fields.encryptedHashRequest = easyPaisaHash(fields, config.hashKey);

  const environment = config.environment === "live" ? "live" : "sandbox";
  return { url: CHECKOUT_URLS.easyPaisa[environment], fields, orderRefNum };
}

function verifyEasyPaisaCallback(fields, config) {
  if (!isEasyPaisaConfigured(config) || !fields?.encryptedHashRequest) return { verified: false };
  const expected = easyPaisaHash(fields, config.hashKey);
  const verified = expected === fields.encryptedHashRequest;
  // EasyPaisa's own success signal has varied by integration version across
  // their docs (responseCode "0000", or status "0000"/"success") - check
  // whichever field is actually present rather than assuming one.
  const successCode = String(fields.responseCode || fields.status || "");
  const success = verified && (successCode === "0000" || successCode.toLowerCase() === "success");
  return { verified, success, txnRefNo: fields.orderRefNum, transactionId: fields.transactionId || fields.orderRefNum };
}

module.exports = {
  isJazzCashConfigured,
  isEasyPaisaConfigured,
  buildJazzCashCheckoutPayload,
  verifyJazzCashCallback,
  buildEasyPaisaCheckoutPayload,
  verifyEasyPaisaCallback,
  // Exported for test tooling only (simulating a gateway's own signed
  // response) - never used by the app's own request/verify flow above,
  // which already computes these internally.
  jazzCashSecureHash,
  easyPaisaHash,
};
