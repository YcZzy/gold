const caches = require("./read-cache");
async function getStatus(platform) {
  const cache = caches.forPlatform(platform);
  return cache.fetch("status", async () => {
    const response = await platform.cloud.callFunction({ name: "getStatus" });
    const result = response && response.result;
    if (!result || !result.ok) return result;
    const previous = cache.read("status");
    return {
      ...previous, ...result,
      prefs: { ...(previous && previous.prefs), ...result.prefs },
      remaining: { ...(previous && previous.remaining), ...result.remaining },
    };
  }, (r) => !!(r && r.ok));
}
function updateStatus(platform, result) {
  const cache = caches.forPlatform(platform);
  if (!result || !result.ok) return;
  const old = cache.read("status");
  if (old) cache.write("status", {
    ...old, ...result,
    prefs: { ...old.prefs, ...result.prefs },
  });
}
module.exports = { getStatus, updateStatus };
