// All app cloud calls pass through this gate. Reservation happens before transport.
// 500 users: 100,000 foreground units + <=89,280 background calls per 31 days.
const LIMIT = 200;
const KEY = 'cloud-call-budget-v1';
const installed = new WeakMap();
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
function monthAt(time) { return new Date(time + 8 * 3600000).toISOString().slice(0, 7); }
function policy(options) {
  const d = options.data || {};
  if (options.name !== 'marketData') return 0;
  return { chart: 900000, resolve: 86400000, search: 300000, discovery: 300000 }[d.action] || 0;
}
function maximum(options) {
  if (options.name === 'portfolio') return 61;
  if (options.name === 'ledger') {
    const action=options.data?.action || 'list';
    if (['list','export','saveNote','voidEntry'].includes(action)) return 1;
    if (action === 'saveEntry') return 2;
    if (['import','previewImport'].includes(action)) return 31;
    return 32;
  }
  return 1;
}
function install(platform, now = Date.now) {
  if (!platform?.cloud?.callFunction || installed.has(platform)) return;
  const transport = platform.cloud.callFunction.bind(platform.cloud);
  const reads = new Map(), pending = new Map();
  let state, reservation = Promise.resolve();
  const persist = (required = true) => {
    try { platform.setStorageSync(KEY, copy(state)); }
    catch (_) {
      if (required) {
        const error = Error('设备存储不可用，无法安全保存操作额度；请释放存储空间后重试，当前操作未发送');
        error.code = 'cloud-call-budget-storage-unavailable'; error.hint = error.message; throw error;
      }
    }
  };
  function current() {
    if (!state) { try { state = platform.getStorageSync(KEY); } catch (_) {} }
    const month = monthAt(now());
    if (!state || state.month !== month || !Number.isInteger(state.used) || state.used < 0) state = { month, used: 0, credits: 0 };
    return state;
  }
  function exhausted() {
    const error = Error('本月云端操作额度不足，已保留现有数据；行情快照仍可查看，请下月再试');
    error.code = 'cloud-call-budget-exceeded'; error.hint = error.message; return error;
  }
  function reserve(cost) {
    // Serialize only admission, never the business request itself.
    const work = reservation.then(async () => {
      const account = current();
      if (account.used + cost > LIMIT || (account.exhausted && (account.credits || 0) < cost)) throw exhausted();
      while ((account.credits || 0) < cost) {
        if (account.retryAt > now()) throw Object.assign(Error('操作额度服务暂不可用，请稍后重试'), {code:'cloud-call-budget-unavailable'});
        if (account.exhausted) throw exhausted();
        if (account.used + cost + 1 > LIMIT) throw exhausted();
        account.used++; persist();
        let lease;
        try { lease = (await transport({name:'callBudget',data:{}}))?.result; }
        catch(e) { account.retryAt = now()+300000; persist(false); throw e; }
        if (!lease?.ok) {
          if (lease?.err === 'cloud-call-budget-exceeded') account.exhausted = true;
          else account.retryAt = now()+300000;
          persist(false);
          const e = lease?.err === 'cloud-call-budget-exceeded' ? exhausted() : Error(lease?.hint || '操作额度服务暂不可用，请稍后重试');
          e.code = lease?.err || 'cloud-call-budget-unavailable'; throw e;
        }
        if (current() !== account || lease.month !== account.month) throw Error('月份已切换，请重试');
        if (!Number.isInteger(lease.credits) || lease.credits < 1 || lease.credits > 99) throw Error('操作额度响应无效');
        account.credits = (account.credits || 0) + lease.credits; persist();
      }
      account.credits -= cost; account.used += cost; persist();
      return account;
    });
    reservation = work.catch(() => {});
    return work;
  }
  async function execute(options) {
    const cost = maximum(options), account = await reserve(cost);
    // A timeout may already have consumed nested invocations. Never refund failures.
    const result = await transport(options);
    const actual = result?.result?.invocationCost;
    if (Number.isInteger(actual) && actual >= 1 && actual <= cost && current() === account) {
      account.used -= cost - actual; account.credits += cost - actual; persist(false);
    }
    return result;
  }
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
      work = execute(request);
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
  installed.set(platform, { status: () => ({ ...current(), limit: LIMIT }) });
}
function status(platform) { return installed.get(platform)?.status(); }
module.exports = { install, status, LIMIT, monthAt };
