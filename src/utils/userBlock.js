// Section 35: accounts that are suspended or removed, held in memory so the
// auth middleware can turn away their sessions without a query per request.
// The suspension service updates the set at once on this server; other
// servers pick the change up on their next refresh (at most 30 seconds).

let blocked = new Map(); // user_id -> 'suspended' | 'removed'
let refreshedAt = 0;
let refresher = null;

const setBlocked = (map) => {
  blocked = map;
  refreshedAt = Date.now();
};
const setRefresher = (fn) => {
  refresher = fn;
};
const block = (userId, state) => blocked.set(userId, state);
const unblock = (userId) => blocked.delete(userId);
const stateOf = (userId) => {
  if (refresher && Date.now() - refreshedAt > 30000) {
    refreshedAt = Date.now();
    Promise.resolve(refresher()).catch(() => {});
  }
  return (userId && blocked.get(userId)) || null;
};

module.exports = { setBlocked, setRefresher, block, unblock, stateOf };
