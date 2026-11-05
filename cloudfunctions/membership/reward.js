const { randomBytes } = require('crypto');
const { read } = require('./payment');

const REWARD_TERM = 86400000;
const TICKET_LIFETIME = 10 * 60000;

async function reward(db, openid, action, ticket, now) {
  return db.runTransaction(async tx => {
    const doc = tx.collection('entitlements').doc(openid);
    const current = await read(doc) || {};
    const lastReward = current.lastAdReward;
    if (action === 'claim' && lastReward && lastReward.ticket === ticket) {
      return { ok: true, expiresAt: lastReward.expiresAt };
    }
    if (current.tier === 'vip' && current.expiresAt > now) {
      return { ok: false, err: 'membership-active' };
    }
    if (lastReward?.expiresAt > now) return { ok: false, err: 'reward-cooldown' };

    if (action === 'start') {
      const pending = { ticket: randomBytes(16).toString('hex'), expiresAt: now + TICKET_LIFETIME };
      const data = { openid, pendingAdReward: pending };
      if (current.openid || current.tier) await doc.update({ data });
      else await doc.set({ data });
      return { ok: true, ticket: pending.ticket };
    }

    const pending = current.pendingAdReward;
    if (!pending || pending.ticket !== ticket || pending.expiresAt <= now) {
      return { ok: false, err: 'reward-ticket-invalid' };
    }
    const expiresAt = now + REWARD_TERM;
    await doc.update({ data: {
      tier: 'vip', expiresAt, pendingAdReward: null, lastAdReward: { ticket, expiresAt },
    } });
    return { ok: true, expiresAt };
  });
}

module.exports = { reward, REWARD_TERM };
