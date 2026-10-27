// Only successful reads are cached. Failed writes must never be treated as success.
function createCache(platform) {
  const memory = new Map();
  const copy = (value) => value == null ? value : JSON.parse(JSON.stringify(value));
  function read(key) {
    if (memory.has(key)) return copy(memory.get(key));
    try {
      const stored = platform && platform.getStorageSync("last-good-v1:" + key);
      if (stored && stored.version === 1) {
        memory.set(key, stored.value);
        return copy(stored.value);
      }
    } catch (ignore) {}
    return null;
  }
  function write(key, value) {
    memory.set(key, copy(value));
    try {
      if (platform) platform.setStorageSync("last-good-v1:" + key, { version: 1, value });
    } catch (ignore) {}
    return copy(value);
  }
  async function fetch(key, request, valid = () => true) {
    try {
      const result = await request();
      if (!valid(result)) throw Error("Unusable read response");
      return write(key, result);
    } catch (error) {
      const cached = read(key);
      if (cached != null) return cached;
      throw error;
    }
  }
  return { read, write, fetch };
}
const clients = new WeakMap();
function forPlatform(platform) {
  if (!clients.has(platform)) clients.set(platform, createCache(platform));
  return clients.get(platform);
}
module.exports = Object.assign(createCache(typeof wx === "undefined" ? null : wx), { createCache, forPlatform });
