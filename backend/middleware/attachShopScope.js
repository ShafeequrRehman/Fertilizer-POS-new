// Small helper used by controllers to build the tenant filter for every
// query. Deliberately trusts ONLY req.user.shopId (from the verified JWT
// payload), never anything from the request body/query string - a client
// can never widen its own scope by passing a different shopId in the
// request. Super Admin routes use their own explicit :shopId route params
// instead of this helper, since the Super Admin is allowed to cross shop
// boundaries by design.
function shopScope(req) {
  if (!req.user || !req.user.shopId) {
    throw Object.assign(new Error("No shop associated with this account"), { statusCode: 403 });
  }
  return { shopId: req.user.shopId };
}

module.exports = { shopScope };
