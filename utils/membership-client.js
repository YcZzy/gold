const PENDING_KEY = 'membership-pending-v1';
const DISMISSED_KEY = 'membership-dismissed-v1';
const CHECK_DELAYS = [0, 1000, 2000, 4000];
const FREE_LIMIT_MESSAGE = '免费版最多关注 5 个标的';

async function call(wx, action, data) {
  const response = await wx.cloud.callFunction({ name: 'membership', data: { action, ...data } });
  const result = response && response.result;
  if (!result || !result.ok) {
    const error = Error(result && result.err === 'payment-not-configured'
      ? '会员购买暂未开放' : '暂时无法确认订单，请稍后重试');
    error.code = result && result.err;
    throw error;
  }
  return result;
}

function pendingOrder(wx) {
  try {
    const pending = wx.getStorageSync(PENDING_KEY);
    return pending && Date.now() - pending.createdAt < 86400000 ? pending.orderId : '';
  } catch (_) {
    return '';
  }
}

async function recoverOrder(wx) {
  const pending = pendingOrder(wx);
  if (pending) return pending;
  const { orderId, createdAt } = await call(wx, 'recover');
  if (!orderId || wx.getStorageSync(DISMISSED_KEY) === orderId) return '';
  wx.setStorageSync(PENDING_KEY, { orderId, createdAt });
  return orderId;
}

async function dismissCheckout(wx, orderId) {
  wx.removeStorageSync(PENDING_KEY);
  wx.setStorageSync(DISMISSED_KEY, orderId);
  try {
    await call(wx, 'dismiss', { orderId });
  } catch (_) {
    // The order remains available to the server's payment reconciliation.
  }
}

async function purchase(wx) {
  if (typeof wx.requestVirtualPayment !== 'function') throw Error('请更新微信后再购买会员');
  const { code } = await new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }));
  const { orderId, payData } = await call(wx, 'create', { code });
  wx.setStorageSync(PENDING_KEY, { orderId, createdAt: Date.now() });
  try {
    await new Promise((resolve, reject) => wx.requestVirtualPayment({ ...payData, success: resolve, fail: reject }));
  } catch (error) {
    if (error.errCode === -2 || /cancel/i.test(error.errMsg || '')) {
      await dismissCheckout(wx, orderId);
      return false;
    }
    if ([-15001, -15005, -15006, -15007, -15010, -15011, -15012, -15013, -15014, -15016].includes(error.errCode)) {
      await dismissCheckout(wx, orderId);
      throw Error('支付未能发起，请稍后重试');
    }
    throw error;
  }
  return true;
}

async function confirm(wx) {
  const orderId = pendingOrder(wx);
  if (!orderId) return null;
  let result;
  try {
    result = await call(wx, 'confirm', { orderId });
  } catch (error) {
    if (error.code !== 'order-not-found') throw error;
    result = { status: 'closed' };
  }
  if (result.status !== 'pending' && pendingOrder(wx) === orderId) wx.removeStorageSync(PENDING_KEY);
  return result;
}

async function confirmUntilSettled(wx, { delays = CHECK_DELAYS, isActive = () => true } = {}) {
  const orderId = pendingOrder(wx);
  if (!orderId) return null;
  for (const delay of delays) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    if (!isActive() || pendingOrder(wx) !== orderId) return null;
    try {
      const result = await confirm(wx);
      if (result && result.status !== 'pending') return result;
    } catch (_) {
      // A network error leaves the payment outcome unknown. Retry the same order.
    }
  }
  return { status: 'pending' };
}

function offerUpgrade(wx, error) {
  if (error.code !== 'watchlist-limit' || !String(error.message).startsWith(FREE_LIMIT_MESSAGE)) return;
  wx.showModal({
    title: '自选数量已达上限',
    content: '免费版最多关注 5 个标的，会员最多关注 30 个。',
    confirmText: '查看会员',
    success: result => {
      if (result.confirm) wx.switchTab({ url: '/pages/mine/mine' });
    },
  });
}

module.exports = { pendingOrder, purchase, confirm, recoverOrder, confirmUntilSettled, offerUpgrade };
