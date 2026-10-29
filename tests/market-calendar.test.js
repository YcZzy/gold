const { test } = require('node:test');
const assert = require('node:assert/strict');
let calendar={};try{calendar=require('../cloudfunctions/sendTask/market-calendar');}catch{}
const {planRuleTask,buildMessage}=require('../cloudfunctions/sendTask/asset-tasks');
const us={id:'usSPY',code:'SPY',name:'SPY',market:'US',kind:'etf',currency:'USD',unit:'美元/份',precision:2,timezone:'America/New_York',supportsClose:true};
const hk={...us,id:'hk02800',code:'02800',name:'盈富基金',market:'HK',currency:'HKD',unit:'港元/份',precision:3,timezone:'Asia/Hong_Kong'};
const cn={...us,id:'sh510300',code:'510300',name:'沪深300ETF',market:'SH',currency:'CNY',unit:'元/份',precision:3,timezone:'Asia/Shanghai'};
const ts=s=>Date.parse(s);
const quote=(asset,at,extra={})=>({assetId:asset.id,price:100,changePct:2,sourceTime:at,fetchedAt:at,stale:false,status:'fresh',source:'tencent',...extra});
const rule=(asset,type,extra={})=>({id:'r',assetId:asset.id,type,enabled:true,value:1,version:'v',...extra});

test('US calendar converts local dates, DST and official early closes',()=>{
  assert.equal(typeof calendar.session,'function');
  for(const [at,close] of [['2026-03-06T16:00Z','2026-03-06T21:00Z'],['2026-03-09T16:00Z','2026-03-09T20:00Z'],['2026-11-02T16:00Z','2026-11-02T21:00Z'],['2026-11-27T16:00Z','2026-11-27T18:00Z']])
    assert.equal(calendar.session(us,ts(at)).closeTime,ts(close));
  assert.equal(calendar.session(us,ts('2026-11-26T16:00Z')).phase,'closed');
});

test('HK half-days include closing auction and CN compensating workdays stay closed',()=>{
  assert.equal(typeof calendar.session,'function');
  const half=calendar.session(hk,ts('2026-12-24T04:05Z'));
  assert.equal(half.phase,'auction');
  assert.equal(half.closeTime,ts('2026-12-24T04:10Z'));
  assert.equal(calendar.session(cn,ts('2026-10-10T02:00Z')).phase,'closed');
  assert.equal(calendar.session(cn,ts('2026-10-02T02:00Z')).phase,'closed');
  assert.equal(calendar.session(cn,ts('2027-01-04T02:00Z')).known,false);
});

test('target and volatility alerts reject delayed prices and off-session timestamps',()=>{
  const at=ts('2026-10-27T14:00Z');
  for(const q of [quote(us,at,{status:'delayed'}),quote(us,at,{status:'unavailable'}),quote(us,at,{isDelayed:true}),quote(us,at,{sourceTime:ts('2026-10-27T13:29Z')})])
    assert.equal(planRuleTask(rule(us,'dailyMove'),us,q,[],at,'u'),null);
  for(const at of [ts('2026-10-27T12:00Z'),ts('2026-10-27T21:00Z'),ts('2026-11-26T15:00Z')])
    assert.equal(planRuleTask(rule(us,'priceAbove'),us,quote(us,at),[],at,'u'),null);
  const cnLunch=ts('2026-10-28T04:30Z');
  assert.equal(planRuleTask(rule(cn,'dailyMove'),cn,quote(cn,cnLunch),[],cnLunch,'u'),null);
});

test('US intraday rule keys follow exchange date across Beijing midnight',()=>{
  const at=ts('2026-10-28T01:00:00+08:00');
  const task=planRuleTask(rule(us,'dailyMove'),us,quote(us,at),[],at,'u');
  assert.ok(task);
  assert.ok(task._id.endsWith('20261027'));
});

test('short-move baselines cannot cross lunch, a trade date or delayed data',()=>{
  const at=ts('2026-10-28T05:02Z');
  const sample={...quote(cn,at-15*60000),at:at-15*60000,price:90};
  assert.equal(planRuleTask(rule(cn,'rapidMove'),cn,quote(cn,at),[sample],at,'u'),null);
});

test('close alerts wait for HK final auction and US half-day regular close',()=>{
  const hkBefore=ts('2026-12-24T04:08Z');
  assert.equal(planRuleTask(rule(hk,'close'),hk,quote(hk,hkBefore),[],hkBefore,'u'),null);
  const hkAfter=ts('2026-12-24T04:20Z');
  assert.ok(planRuleTask(rule(hk,'close'),hk,quote(hk,ts('2026-12-24T04:09Z'),{fetchedAt:hkAfter}),[],hkAfter,'u'));
  const at=ts('2026-11-27T18:10Z');
  const task=planRuleTask(rule(us,'close'),us,quote(us,ts('2026-11-27T18:00:01Z'),{fetchedAt:at}),[],at,'u');
  assert.ok(task);
  assert.ok(task._id.endsWith('20261127'));
  assert.equal(planRuleTask(rule(us,'close'),us,quote(us,ts('2026-11-27T17:59Z'),{fetchedAt:at}),[],at,'u'),null);
  assert.equal(planRuleTask(rule(us,'close'),us,quote(us,at,{session:'post'}),[],at,'u'),null);
});

test('close alerts fail closed on unknown years and quote dates',()=>{
  const at=ts('2027-01-04T07:10Z');
  assert.equal(planRuleTask(rule(cn,'close'),cn,quote(cn,at),[],at,'u'),null);
  const close=ts('2026-10-28T07:10Z');
  assert.equal(planRuleTask(rule(cn,'close'),cn,quote(cn,ts('2026-10-27T07:00Z'),{fetchedAt:close}),[],close,'u'),null);
});

test('HK messages retain HKD and ETF precision; scheduled time stays Beijing',()=>{
  const at=ts('2026-10-28T02:00Z');
  const task=planRuleTask(rule(hk,'scheduled',{time:'10:00'}),hk,quote(hk,at,{price:23.780}),[],at,'u');
  assert.ok(task);
  assert.equal(buildMessage(task).thing6.value,'23.780 港元/份');
  assert.match(buildMessage(task).time9.value,/2026-10-28 10:00/);
});

test('HKD broadcasts use a text-price template and spend its matching quota',async()=>{
  const {memoryDb}=require('./helpers/asset-db');
  const {createAssetTasks}=require('../cloudfunctions/sendTask/asset-tasks');
  const {templates}=require('../utils/app-config');
  const at=ts('2026-10-28T02:00Z'),r=rule(hk,'scheduled',{time:'10:00'});
  const {db,tables}=memoryDb({
    portfolios:[{_id:'u',openid:'u',items:[hk.id],rules:[r],migrationVersion:1}],
    preferences:[{_id:'u',multiAssetVersion:1}],
    subscriptions:[{_id:'u:'+templates.dailyBrief,remaining:3},{_id:'u:'+templates.volatility,remaining:3}],
  });
  const sent=[];
  const cloud={callFunction:async()=>({result:{ok:true,assets:[hk],quotes:[quote(hk,at,{price:23.780})]}}),
    openapi:{subscribeMessage:{send:async data=>{sent.push(data);}}}};
  const engine=createAssetTasks({db,cloud,templates,now:()=>at});
  await engine.scan();await engine.handleTask(tables.sendTasks[0]);
  assert.equal(sent.length,1);
  assert.equal(sent[0].templateId,templates.volatility);
  assert.equal(sent[0].data.thing6.value,'23.780 港元/份');
  assert.equal(tables.subscriptions.find(s=>s._id==='u:'+templates.volatility).remaining,2);
  assert.equal(tables.subscriptions.find(s=>s._id==='u:'+templates.dailyBrief).remaining,3);
});

test('two US trade dates within one Beijing date have independent per-security rule counts',async()=>{
  const {memoryDb}=require('./helpers/asset-db');
  const {createAssetTasks}=require('../cloudfunctions/sendTask/asset-tasks');
  const {templates}=require('../utils/app-config');
  let at=ts('2026-10-27T17:00Z');
  const r=rule(us,'dailyMove');
  const {db,tables}=memoryDb({
    portfolios:[{_id:'u',openid:'u',items:[us.id],rules:[r],migrationVersion:1}],
    preferences:[{_id:'u',multiAssetVersion:1,dndStart:'00:00',dndEnd:'00:00'}],
    subscriptions:[{_id:'u:'+templates.volatility,remaining:3}],
  });
  const sent=[];
  const cloud={callFunction:async()=>({result:{ok:true,assets:[us],quotes:[quote(us,at)]}}),
    openapi:{subscribeMessage:{send:async data=>{sent.push(data);}}}};
  const engine=createAssetTasks({db,cloud,templates,now:()=>at});
  await engine.scan();await engine.handleTask(tables.sendTasks[0]);
  at=ts('2026-10-28T14:00Z');
  await engine.scan();await engine.handleTask(tables.sendTasks.find(t=>t.status==='pending'));
  assert.equal(sent.length,2);
  assert.equal(tables.sendBudgets[0]._id,'u:20261028');
  assert.equal(tables.sendBudgets[0].regular,2);
});
