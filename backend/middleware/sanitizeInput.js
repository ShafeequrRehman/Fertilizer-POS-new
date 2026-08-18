// Strips MongoDB operator injection out of every incoming request before
// any route handler sees it. Several controllers build a Mongo filter by
// assigning a request field straight in - e.g. orderController.getOrders'
// `query.status = req.query.status` - trusting it to be a plain string.
// Express's default query parser (the `qs` library) turns bracket
// notation into nested objects, so a request like
// GET /api/orders?status[$ne]=cancelled
// hands that assignment `{ $ne: "cancelled" }` instead of a string,
// letting the caller splice their own operator into a query that was only
// ever meant to accept one of a few known status values. shopId is always
// ANDed in from the JWT everywhere this happens, so this was never a
// cross-shop data leak, but it's still a real hole in each handler's own
// filtering logic - and relying on every current AND future handler to
// remember to type-check every field it reads off req.query/req.body is
// exactly the kind of thing that quietly breaks once. Closing it once
// here, for every route, is the same reasoning as raising the global
// axios timeout in src/lib/api.ts instead of special-casing each slow
// endpoint one at a time.
//
// Deliberately mutates objects IN PLACE rather than reassigning
// req.query/req.body/req.params - Express 5's req.query is a getter with
// no setter (this app is on Express 5, see package.json), so
// `req.query = sanitized` would throw on every single request.
function sanitizeInPlace(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 10) return;

  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".")) {
      delete value[key];
      continue;
    }
    sanitizeInPlace(value[key], depth + 1);
  }
}

module.exports = function sanitizeInput(req, res, next) {
  sanitizeInPlace(req.body);
  sanitizeInPlace(req.query);
  sanitizeInPlace(req.params);
  next();
};
