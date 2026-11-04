// Historical module name retained for the app entry point.
// Cloud calls have no application monthly quota; only read caching and deduplication remain.
const installed = new WeakSet();
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function policy(options) {
  const d = options.data || {};
  if (options.name !== 'marketData') return 0;
  return { chart: 900000, resolve: 86400000, search: 300000, discovery: 300000 }[d.action] || 0;
}
function install(platform, now = Date.now) {
  if (!platform?.cloud?.callFunction || installed.has(platform)) return;
  const transport = platform.cloud.callFunction.bind(platform.cloud);
  const reads = new Map(), pending = new Map();
  platform.cloud.callFunction = function(options = {}) {
    const { success, fail, complete, ...request } = options;
    const ttl = policy(request), key = JSON.stringify([request.name, request.data || {}]);
    const saved = reads.get(key), age = saved && now() - saved.at;
    let work;
    if (ttl && saved && age >= 0 && age < ttl) {
      const value = copy(saved.value);
      if (value.result?.chart) {
        value.result.budgetCached = true;
        value.result.chart = {...value.result.chart,cached:true};
      }
      work = Promise.resolve(value);
    }
    else if (ttl && pending.has(key)) work = pending.get(key).then(copy);
    else {
      work = Promise.resolve().then(() => transport(request));
      if (ttl) {
        pending.set(key, work);
        work.then(value => {
          if (value?.result?.ok === true) reads.set(key, { at: now(), value: copy(value) });
          pending.delete(key);
        }, () => pending.delete(key));
        work = work.then(copy);
      }
    }
    return work.then(value => { success?.(value); complete?.(value); return value; }, error => {
      fail?.(error); complete?.(error); throw error;
    });
  };
  installed.add(platform);
}
module.exports = { install };
