// Public projection only. Never read portfolios, private caches, ledgers or quotas here.
const MAX_AGE = 7 * 86400000;
function trading(asset, now) {
  if (asset.kind === 'gold') return true;
  let offset = 8;
  if (asset.market === 'US') {
    const year = new Date(now).getUTCFullYear();
    const sunday = (month, nth) => { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + (7-first)%7 + (nth-1)*7; };
    const start = Date.UTC(year,2,sunday(2,2),7), end = Date.UTC(year,10,sunday(10,1),6);
    offset = now >= start && now < end ? -4 : -5;
  }
  const d = new Date(now + offset * 3600000), min = d.getUTCHours()*60+d.getUTCMinutes();
  if ([0,6].includes(d.getUTCDay())) return false;
  if (asset.market === 'US') return min >= 570 && min < 960;
  if (asset.market === 'HK') return (min >= 570 && min < 720) || (min >= 780 && min < 970);
  if (['SH','SZ','BJ'].includes(asset.market)) return (min >= 570 && min < 690) || (min >= 780 && min < 900);
  return true;
}
async function read(platform, ids, now = Date.now()) {
  const assets = [], quotes = [], missing = new Set(ids);
  if (!platform?.cloud?.database) return { assets, quotes, missing: [...missing] };
  try {
    const db = platform.cloud.database();
    for (let i = 0; i < ids.length; i += 20) {
      const group = ids.slice(i,i+20);
      const response = await db.collection('publicQuotes').where({ _id: db.command.in(group) }).limit(20).get();
      for (const row of response.data || []) {
        const a = row.asset, q = row.quote, age = q && now-q.fetchedAt;
        if (!group.includes(row._id) || a?.id !== row._id || q?.assetId !== row._id ||
            q.status === 'unavailable' || !Number.isFinite(q.price) || q.price <= 0 || !Number.isFinite(age) || age < 0 || age >= MAX_AGE ||
            !Number.isFinite(q.sourceTime) || q.sourceTime <= 0 || q.sourceTime > now + 60000) continue;
        const reusable = age < 120000 || !trading(a,now);
        const stale = !!q.stale || age >= 120000 || q.status !== 'fresh';
        assets.push(JSON.parse(JSON.stringify(a)));
        quotes.push(JSON.parse(JSON.stringify({ ...q, ...(stale ? { stale:true,cached:true,status:'delayed' } : {}) })));
        if (reusable) missing.delete(row._id);
      }
    }
  } catch (_) { /* Permission/deployment errors fall back through the metered transport. */ }
  return { assets, quotes, missing: [...missing] };
}
module.exports = { read, trading };
