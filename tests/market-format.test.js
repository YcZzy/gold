const {test}=require('node:test');
const assert=require('node:assert/strict');
const fmt=require('../utils/asset-format');
const {createKlineChart}=require('../utils/candle-chart');
const asset={market:'HK',kind:'etf',currency:'HKD',precision:3};

test('ETF changes, OHLC statistics and money keep the security currency and precision',()=>{
  const q=fmt.quote({price:23.780,change:0.029,open:23.740,high:23.840,low:23.680,prevClose:23.700,amount:1250000,volume:10000,volumeUnit:null},asset);
  assert.equal(q.priceText,'23.780');
  assert.equal(q.changeText,'+0.029');
  assert.equal(q.openText,'23.740');
  assert.equal(q.amountText,'125.00 万港元');
  assert.equal(q.volumeText,'--');
});

test('resting market and lunch states preserve independent delay and cache labels',()=>{
  const base={price:10,sourceTime:Date.now()-86400000,status:'delayed',marketState:'closed'};
  assert.match(fmt.quote(base,asset).statusText,/已休市/);
  assert.doesNotMatch(fmt.quote(base,asset).statusText,/刷新失败/);
  assert.match(fmt.quote({...base,marketState:'break',sourceTime:Date.now(),status:'fresh'},asset).statusText,/午间休市/);
  assert.match(fmt.quote({...base,marketState:'regular'},asset).statusText,/延迟/);
  assert.match(fmt.quote({...base,cached:true,stale:true},asset).statusText,/刷新失败/);
  assert.match(fmt.quote({...base,stale:true},asset).statusText,/缓存.*刷新失败/);
});

test('market identity separates listing region from instrument type',()=>{
  assert.equal(typeof fmt.identity,'function');
  assert.deepEqual(fmt.identity(asset),{marketText:'港股',kindText:'ETF'});
  assert.deepEqual(fmt.identity({market:'US',kind:'stock'}),{marketText:'美股',kindText:'股票'});
});

test('chart latest-price and crosshair labels show all three ETF decimals',()=>{
  const labels=[];
  const ctx=new Proxy({fillText:value=>labels.push(String(value))},{get:(target,key)=>key in target?target[key]:()=>{}});
  const chart=createKlineChart({canvas:{},ctx,width:360,height:240,precision:3});
  chart.renderIntraday([{time:'2026-10-28 10:00',price:4.152,avg:4.151,v:null}],4.123);
  assert.ok(labels.includes('4.152'));
  chart.touchAt(10);
  assert.ok(labels.filter(s=>s==='4.152').length>=2);
});
