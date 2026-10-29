const test=require('node:test'),assert=require('node:assert/strict');
const transfer=require('../utils/data-transfer');
test('text, quoted CSV and versioned JSON preserve identifiers, notes and unicode tags',()=>{
  assert.deepEqual(transfer.parse('600519\nsh510300,usBRK.B').map(r=>r.keyword),['600519','sh510300','usBRK.B']);
  const r=transfer.parse('id,note,tags,groups\nsh600519,"观察,等待",消费|长期,核心');
  assert.equal(r[0].note,'观察,等待'); assert.deepEqual(r[0].tags,['消费','长期']);
  assert.throws(()=>transfer.parse('{"schema":"other","version":1,"items":[]}'),/格式/);
  const state={items:[{id:'sh600519',name:'贵州茅台'}],annotations:{sh600519:{note:'测试',tags:['消费']}},groups:[{name:'核心',assetIds:['sh600519'],sortBy:'changePct',sortDirection:'desc'}]};
  const saved=JSON.parse(transfer.exportJson(state));
  assert.equal(saved.openid,undefined); assert.equal(saved.schema,'gold-watchlist');
  assert.equal(transfer.parse(transfer.exportJson(state))[0].note,'测试');
  assert.equal(transfer.parse(transfer.exportJson(state)).groupSettings[0].sortBy,'changePct');
});
test('file size and row limits fail explicitly, CSV cells cannot execute spreadsheet formulas',()=>{
  assert.throws(()=>transfer.parse('a'.repeat(262145)),/大小/);
  assert.throws(()=>transfer.parse(Array.from({length:31},(_,i)=>'sh'+String(600000+i)).join('\n')),/30/);
  assert.match(transfer.exportCsv({items:[{id:'sh600519',name:'=HYPERLINK(1)'}],annotations:{}}),/'=HYPERLINK/);
});
test('CSV round trip preserves literal separators in tags and group names',()=>{
 const state={items:[{id:'sh600519',name:'甲'}],annotations:{sh600519:{note:'',tags:['长|期']}},groups:[{name:'组|合',assetIds:['sh600519']}]};
 const row=transfer.parse(transfer.exportCsv(state))[0];
 assert.deepEqual(row.tags,['长|期']);assert.deepEqual(row.groups,['组|合']);
});
