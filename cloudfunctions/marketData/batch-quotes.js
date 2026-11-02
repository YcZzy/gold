// One function invocation, bounded provider/database concurrency. No recursive cloud calls.
async function batchQuotes(ids, quotes) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2500) throw Error('请传入 1 至 2500 个资产代码');
  const unique = [...new Set(ids)], result = { ok:true, assets:[], quotes:[], errors:[] };
  let offset = 0;
  async function worker() {
    while (offset < unique.length) {
      const batch = unique.slice(offset, offset += 30);
      try {
        const r = await quotes(batch);
        if (!r || !r.ok) throw Error(r?.hint || '行情暂不可用');
        result.assets.push(...r.assets || []); result.quotes.push(...r.quotes || []); result.errors.push(...r.errors || []);
      } catch (e) { result.errors.push(...batch.map(assetId => ({assetId,hint:e.message}))); }
    }
  }
  // Keep the small-watchlist workload unchanged; 2500 stocks need 84 batches.
  const concurrency = unique.length <= 500 ? 3 : 10;
  await Promise.all(Array.from({length:Math.min(concurrency,Math.ceil(unique.length/30))}, worker));
  return result;
}
module.exports = { batchQuotes };
