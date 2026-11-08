const PENDING_KEY = 'membership-pending-v1';
const DISMISSED_KEY = 'membership-dismissed-v1';
const CHECK_DELAYS = [0, 1000, 2000, 4000];
const FREE_LIMIT_MESSAGE = '免费版最多关注 5 个项目';

// 官方 wx.requestVirtualPayment 失败码，逐条给出用户可执行的下一步。
const PAYMENT_ERRORS = {
  '-1': '支付未完成，请稍后查询订单确认结果',
  '-4': '本次支付被风控拦截，请稍后再试',
  '-5': '开通结果暂未确认，请稍后查询订单',
  '-15001': '支付参数异常，请更新微信后重试',
  '-15002': '订单号冲突，请重新发起购买',
  '-15003': '支付系统繁忙，请稍后重试',
  '-15004': '支付币种异常，请稍后重试',
  '-15005': '登录状态校验失败，请关闭小程序后重新进入',
  '-15006': '支付校验失败，请关闭小程序后重新进入',
  '-15007': '登录状态已过期，请关闭小程序后重新进入',
  '-15008': '会员购买暂未开放，请稍后再试',
  '-15009': '会员商品暂未上架，请稍后再试',
  '-15010': '会员商品暂不可购买，请稍后再试',
  '-15011': '当前为测试环境，暂不支持 iOS 支付',
  '-15012': '订单已关闭，请重新发起购买',
  '-15013': '商品价格已调整，请重新进入后再试',
  '-15014': '会员商品正在生效，请 10 分钟后再试',
  '-15016': '支付参数异常，请更新微信后重试',
  '-15017': '支付暂时不可用，请稍后再试',
  '-15018': '会员商品暂不可购买，请稍后再试',
  '-15019': '支付暂时不可用，请稍后再试',
  '-15020': '操作过于频繁，请稍后再试',
  '-15021': '交易过于频繁，请稍后再试',
  1001: '支付参数异常，请更新微信后重试',
};
// 结果未知的失败保留订单核对；其余失败已明确未扣款，可直接放弃本次订单。
const UNCERTAIN = ['-1', '-5'];

const CALL_ERRORS = {
  'payment-not-configured': '会员购买暂未开放',
  'payment-ios-sandbox': 'iOS 端暂不支持测试环境支付，请在正式版购买',
};

function devicePlatform(wx) {
  try {
    if (typeof wx.getDeviceInfo === 'function') return String(wx.getDeviceInfo().platform || '').toLowerCase();
    return String(wx.getSystemInfoSync().platform || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

async function call(wx, action, data) {
  const response = await wx.cloud.callFunction({ name: 'membership', data: { action, ...data } });
  const result = response && response.result;
  if (!result || !result.ok) {
    const error = Error(CALL_ERRORS[result && result.err] || '暂时无法确认订单，请稍后重试');
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
  const { orderId, payData } = await call(wx, 'create', { code, platform: devicePlatform(wx) });
  wx.setStorageSync(PENDING_KEY, { orderId, createdAt: Date.now() });
  try {
    await new Promise((resolve, reject) => wx.requestVirtualPayment({ ...payData, success: resolve, fail: reject }));
  } catch (error) {
    const errCode = error && error.errCode;
    if (errCode === -2 || /cancel/i.test((error && error.errMsg) || '')) {
      await dismissCheckout(wx, orderId);
      return false;
    }
    const message = PAYMENT_ERRORS[errCode];
    if (message) {
      console.warn('[membership] virtual payment failed', errCode, (error && error.errMsg) || '');
      if (!UNCERTAIN.includes(String(errCode))) await dismissCheckout(wx, orderId);
      const failure = Error(message);
      failure.code = 'payment-failed';
      throw failure;
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
  if (error.code !== 'watchlist-limit' || (!String(error.message).startsWith(FREE_LIMIT_MESSAGE) && !String(error.message).startsWith('免费版最多关注 5 个标的'))) return;
  wx.showModal({
    title: '关注数量已达上限',
    content: '免费版最多关注 5 个项目，会员最多关注 30 个。',
    confirmText: '查看会员',
    success: result => {
      if (result.confirm) wx.switchTab({ url: '/pages/mine/mine' });
    },
  });
}

module.exports = { pendingOrder, purchase, confirm, recoverOrder, confirmUntilSettled, offerUpgrade };
