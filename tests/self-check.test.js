const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadEngine } = require('./helpers/cloud-harness');
const template = 'mQZ8fr72Xbf5nMlEjhP1ie9gl-2ndoeZa8_8upWsDYs';

test('test notification sends to caller and consumes one authorization', async () => {
  const engine = loadEngine({ openid: 'caller', tables: { subscriptions: [{ _id: 'caller:' + template, openid: 'caller', templateId: template, remaining: 2 }] } });
  const result = await engine.main({ action: 'testNotification' });
  assert.equal(result.ok, true);
  assert.equal(engine.sent.length, 1);
  assert.equal(engine.sent[0].touser, 'caller');
  assert.equal(engine.tables.subscriptions[0].remaining, 1);
});

test('test notification does not send without quota or caller', async () => {
  const engine = loadEngine({ openid: 'caller' });
  assert.equal((await engine.main({ action: 'testNotification' })).err, 'no-quota');
  assert.equal(engine.sent.length, 0);
  assert.equal((await loadEngine().main({ action: 'testNotification' })).err, 'no-openid');
});

test('explicit send failure refunds quota, uncertain failure does not', async () => {
  for (const [error, remaining, err] of [[{errCode: 43101}, 1, 'send-failed'], [{message: 'timeout'}, 0, 'send-uncertain']]) {
    const engine = loadEngine({ openid: 'caller', sendError: error, tables: { subscriptions: [{ _id: 'caller:' + template, openid: 'caller', templateId: template, remaining: 1 }] } });
    assert.equal((await engine.main({ action: 'testNotification' })).err, err);
    assert.equal(engine.tables.subscriptions[0].remaining, remaining);
  }
});
