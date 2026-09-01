// Escapes every MongoDB/JS regex special character in a string that's
// about to be interpolated into a Mongoose $regex query (customer/product
// search-by-name, etc). Without this, a search box directly hands
// attacker-controlled text to Mongo's regex engine as-is - at best that
// means a search for "a.b" also matching "aXb" (wrong results, not a
// security bug on its own), but a deliberately crafted pattern (nested
// quantifiers like "(a+)+" or a very long alternation) can trigger
// catastrophic backtracking and hang the query for a long time - a
// same-tenant denial-of-service. Every call site that builds a $regex
// filter from a request field the caller typed (search box, "q", etc.)
// should run it through this first.
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = { escapeRegex };
