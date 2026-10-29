const {test}=require('node:test');
const assert=require('node:assert/strict');
const {coverage}=require('../cloudfunctions/marketData/history-coverage');
const row=date=>[date,'100','101','102','99','1'];
test('observed month-long availability is not proof of a recent listing',()=>{
  const rows=[row('2026-09-28'),row('2026-10-27')];
  const result=coverage(rows,rows,{id:'usNEW',historyAvailableFrom:'2026-09-28'},'2021-10-28');
  assert.equal(result.status,'unverified');assert.equal(result.verified,false);
});
test('a later cached observation cannot erase already verified older history',()=>{
  const rows=[row('2026-09-28'),row('2026-10-27')];
  const result=coverage(rows,rows,{id:'usAAPL',historyAvailableFrom:'2026-09-28'},'2021-10-28');
  assert.equal(result.status,'truncated');
  assert.equal(result.knownHistoryStart,'2020-11-05');
});
test('confirmed short history must not contradict verified earlier records',()=>{
  const rows=[row('2026-09-28'),row('2026-10-27')];
  const result=coverage(rows,rows,{id:'usAAPL',historyRangeConfirmedFrom:'2026-09-28'},'2021-10-28');
  assert.equal(result.status,'truncated');assert.equal(result.verified,false);
});
