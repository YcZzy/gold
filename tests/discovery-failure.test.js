const test=require('node:test'),assert=require('node:assert/strict');
const {createService}=require('../cloudfunctions/marketData');
test('discovery network failures remain explicit and show a useful message rather than a transport exception',async()=>{
 const service=createService({request:async()=>{throw Error('socket hang up');}});
 const r=await service.handle({action:'discovery',mode:'indices'});
 assert.equal(r.ok,false);assert.match(r.hint,/数据源.*暂不可用/);assert.doesNotMatch(r.hint,/socket/);
});
