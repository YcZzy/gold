/** Server is authoritative; cached data is read-only and explicitly marked offline. */
const CACHE_KEY = "portfolio-cache-v1";
const DEFAULT_ITEMS = [
  {
    id: "gold-au9999",
    name: "沪金 Au99.99",
    code: "AU9999",
    market: "SGE",
    kind: "gold",
    currency: "CNY",
    unit: "元/克",
    secid: "118.AU9999",
    quoteCode: null,
    precision: 2,
  },
  {
    id: "gold-xauusd",
    name: "伦敦金现",
    code: "XAU",
    market: "GLOBAL",
    kind: "gold",
    currency: "USD",
    unit: "美元/盎司",
    secid: "122.XAU",
    quoteCode: null,
    precision: 2,
  },
];
function createClient(platform) {
  let lastGood = null;
  async function call(action, payload) {
    try {
      if (!platform || !platform.cloud || !platform.cloud.callFunction)
        throw new Error("cloud unavailable");
      const response = await platform.cloud.callFunction({
        name: "portfolio",
        data: Object.assign({}, payload, { action }),
      });
      const result = response && response.result;
      if (!result || result.ok !== true) {
        const error = new Error(
          (result && result.hint) || "自选服务暂不可用，请稍后重试",
        );
        error.code = (result && result.err) || "portfolio-unavailable";
        error.business = !!(result && result.ok === false);
        throw error;
      }
      lastGood = result;
      const cache = require("./read-cache").forPlatform(platform);
      for (const asset of result.items || []) cache.write("asset:" + asset.id, asset);
      try {
        platform.setStorageSync(CACHE_KEY, result);
      } catch (ignore) {}
      return result;
    } catch (error) {
      if (action === "list") {
        let cached = lastGood;
        try {
          cached = cached || (platform && platform.getStorageSync(CACHE_KEY));
        } catch (ignore) {}
        if (error.business && !cached) {
          error.hint = error.hint || error.message;
          throw error;
        }
        const fallback =
          cached && Array.isArray(cached.items)
            ? cached
            : {
                items: DEFAULT_ITEMS.map((item) => Object.assign({}, item)),
                rules: [],
                limits: {
                  watchlist: 5,
                  activeRules: 30,
                  tier: "free",
                  expiresAt: null,
                },
                revision: 0,
              };
        return Object.assign({}, fallback, {
          ok: true,
          offline: true,
          hint: "当前离线，显示上次保存的自选；联网后可修改",
        });
      }
      if (!error.hint)
        error.hint = error.message || "自选服务暂不可用，请稍后重试";
      throw error;
    }
  }
  return {
    list: () => call("list"),
    add: (assetId) => call("add", { assetId }),
    remove: (assetId) => call("remove", { assetId }),
    reorder: (assetIds, revision) => call("reorder", { assetIds, revision }),
    saveRule: (rule) => call("saveRule", rule),
    deleteRule: (ruleId) => call("deleteRule", { ruleId }),
  };
}
const client = createClient(typeof wx !== "undefined" ? wx : null);
module.exports = Object.assign(client, { createClient, DEFAULT_ITEMS });
