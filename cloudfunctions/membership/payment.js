const { createHmac, createHash } = require('crypto');

const TERM = 30 * 86400000;
const hmac = (key, body) => createHmac('sha256', key).update(body).digest('hex');

function signPurchase(order, appKey, sessionKey) {
  const signData = JSON.stringify({
    offerId: '1450698745', buyQuantity: 1, env: order.env, currencyType: 'CNY',
    productId: order.productId, goodsPrice: order.price, outTradeNo: order._id,
  });
  return {
    mode: 'short_series_goods', signData,
    paySig: hmac(appKey, 'requestVirtualPayment&' + signData),
    signature: hmac(sessionKey, signData),
  };
}

async function read(doc) {
  try {
    return (await doc.get()).data;
  } catch (error) {
    if (error.code === 'DOCUMENT_NOT_FOUND' || error.errCode === 'DATABASE_DOCUMENT_NOT_EXIST' ||
        /document(?: with _id [^\r\n]+?)? (?:does not exist|not exists?|not found)\b/i.test(
          [error.message, error.errMsg].filter(Boolean).join(' '))) return null;
    throw error;
  }
}

function isPaid(order, remote) {
  return !!remote && remote.order_id === order._id &&
    typeof remote.wx_order_id === 'string' && !!remote.wx_order_id &&
    remote.paid_fee === order.price && [0, 7].includes(remote.order_type) &&
    [2, 3, 4].includes(remote.status);
}

async function deliver(db, order, remote, now) {
  if (!isPaid(order, remote)) throw Error('payment-mismatch');
  return db.runTransaction(async tx => {
    const orderDoc = tx.collection('membershipOrders').doc(order._id);
    const stored = await read(orderDoc);
    if (!stored || stored.openid !== order.openid || stored.env !== order.env ||
        stored.productId !== order.productId || stored.price !== order.price) throw Error('order-mismatch');
    if (stored.deliveredAt) {
      if (stored.wxOrderId !== remote.wx_order_id) throw Error('receipt-mismatch');
      return stored.expiresAt;
    }

    const receiptId = createHash('sha256').update(order.env + ':' + remote.wx_order_id).digest('hex').slice(0, 32);
    const receiptDoc = tx.collection('membershipReceipts').doc(receiptId);
    if (await read(receiptDoc)) throw Error('receipt-already-used');
    const entitlement = tx.collection('entitlements').doc(order.openid);
    const current = await read(entitlement);
    const expiry = current && current.tier === 'vip' && Number.isFinite(current.expiresAt) ? current.expiresAt : 0;
    const expiresAt = Math.max(now, expiry) + TERM;
    const data = { openid: order.openid, tier: 'vip', expiresAt };
    if (current) await entitlement.update({ data });
    else await entitlement.set({ data });
    await receiptDoc.set({ data: { orderId: order._id } });
    await orderDoc.update({ data: { deliveredAt: now, expiresAt, wxOrderId: remote.wx_order_id } });
    return expiresAt;
  });
}

module.exports = { TERM, hmac, signPurchase, read, isPaid, deliver };
