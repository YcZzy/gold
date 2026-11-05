const AD_UNIT = 'adunit-d772dee7197b835f';
const CLAIM_KEY = 'pending-ad-membership-reward';

async function request(wx, action, ticket) {
  const response = await wx.cloud.callFunction({ name: 'membership', data: { action, ticket } });
  return response.result;
}

async function watch(ad) {
  let onClose;
  const closed = new Promise(resolve => {
    onClose = result => resolve(result?.isEnded === true);
    ad.onClose(onClose);
  });
  try {
    await ad.show().catch(() => ad.load().then(() => ad.show()));
    return await closed;
  } finally {
    ad.offClose(onClose);
  }
}

function pendingTicket(wx) {
  try {
    const ticket = wx.getStorageSync(CLAIM_KEY);
    return typeof ticket === 'string' && /^[a-f0-9]{32}$/.test(ticket) ? ticket : '';
  } catch (_) {
    return '';
  }
}

async function claim(wx, page) {
  let ticket = pendingTicket(wx);
  if (!ticket) {
    if (typeof wx.createRewardedVideoAd !== 'function') return { err: 'ad-unsupported' };
    const started = await request(wx, 'startAdReward');
    if (!started?.ok) return started || {};
    if (!page._alive || !page._visible) return { err: 'ad-incomplete' };
    if (!page._rewardAd) {
      page._rewardAd = wx.createRewardedVideoAd({ adUnitId: AD_UNIT });
    }
    if (!await watch(page._rewardAd)) return { err: 'ad-incomplete' };
    ticket = started.ticket;
    try { wx.setStorageSync(CLAIM_KEY, ticket); } catch (_) {}
  }
  const result = await request(wx, 'claimAdReward', ticket);
  if (result?.ok || ['reward-ticket-invalid', 'membership-active', 'reward-cooldown'].includes(result?.err)) {
    try { wx.removeStorageSync(CLAIM_KEY); } catch (_) {}
  }
  return result || {};
}

module.exports = { claim, hasPending: wx => !!pendingTicket(wx) };
