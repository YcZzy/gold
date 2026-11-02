// Coalesce only overlapping read requests. No TTL, write caching or cross-user storage.
function createPool() {
  const pending = new Map();
  const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return {
    run(key, read) {
      if (!pending.has(key)) {
        const work = (async () => read())();
        pending.set(key, work);
        const clear = () => { if (pending.get(key) === work) pending.delete(key); };
        work.then(clear, clear);
      }
      return pending.get(key).then(copy);
    },
    invalidate(key) { pending.delete(key); },
  };
}
const pools = new WeakMap(), unavailable = createPool();
function forPlatform(platform) {
  if (!platform || typeof platform !== 'object') return unavailable;
  if (!pools.has(platform)) pools.set(platform, createPool());
  return pools.get(platform);
}
module.exports = { forPlatform };
