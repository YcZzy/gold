const test=require('node:test'),assert=require('node:assert/strict');
const {pageHarness}=require('./helpers/page-harness');
const a={id:'sh600519',name:'贵州茅台',code:'600519',kind:'stock',market:'SH'};
const s={items:[a],groups:[],annotations:{},revision:2,limits:{watchlist:5}};
test('import preview preserves ambiguous matches until user selects, commit uses exact identities',async()=>{
  const calls=[];
  const {page}=pageHarness('pages/data/data.js',{'portfolio-client':{list:async()=>s,batchAdd:async(...args)=>{calls.push(args);return s;}},
    'market-client':{search:async()=>({assets:[a,{...a,id:'sz600519',market:'SZ'}]})}});
  page.onLoad();await page.onShow();page.onImportInput({detail:{value:'600519'}});await page.previewImport();
  assert.equal(page.data.preview[0].assetId,'');assert.equal(calls.length,0);
  page.selectCandidate({currentTarget:{dataset:{row:0,index:0}}});await page.commitImport();
  assert.equal(calls.length,1);assert.deepEqual(Array.from(calls[0][0]),['sh600519']);assert.equal(calls[0][1],2);
});
test('group edits require explicit save and failed imports retain preview',async()=>{
  const calls=[];
  const {page}=pageHarness('pages/data/data.js',{'portfolio-client':{list:async()=>s,saveGroup:async(...args)=>{calls.push(args);return s;},batchAdd:async()=>{throw Error('名额已满');}},
    'market-client':{resolve:async()=>({asset:a})}});
  page.onLoad();await page.onShow();page.editGroup({currentTarget:{dataset:{id:''}}});
  page.onGroupName({detail:{value:'核心'}});assert.equal(calls.length,0);await page.saveGroup();assert.equal(calls.length,1);
  page.onImportInput({detail:{value:'sh600519'}});await page.previewImport();await page.commitImport();
  assert.match(page.data.errorText,/名额/);assert.equal(page.data.preview.length,1);
});
test('late file reads cannot replace a newer selected file',async()=>{
 let n=0;const finish={};const {page}=pageHarness('pages/data/data.js',{'portfolio-client':{list:async()=>s},wx:{
  chooseMessageFile:opts=>opts.success({tempFiles:[{path:++n===1?'A':'B',size:1}]}),
  getFileSystemManager:()=>({readFile:opts=>{finish[opts.filePath]=()=>opts.success({data:opts.filePath});}})
 }});
 page.onLoad();await page.onShow();const first=page.chooseFile();await new Promise(r=>setImmediate(r));
 const second=page.chooseFile();await new Promise(r=>setImmediate(r));finish.B();await second;finish.A();await first;
 assert.equal(page.data.raw,'B');
});
test('removing a backup preview row also removes it from imported group membership',async()=>{
 let received;const b={...a,id:'sh600418',code:'600418'};
 const{page}=pageHarness('pages/data/data.js',{'portfolio-client':{list:async()=>s,batchAdd:async(...args)=>{received=args;return s;}},
 'market-client':{resolve:async id=>({asset:id===a.id?a:b})}});
 page.onLoad();await page.onShow();page.onImportInput({detail:{value:JSON.stringify({schema:'gold-watchlist',version:1,
  items:[{id:a.id},{id:b.id}],groups:[{name:'组',assetIds:[b.id,a.id],sortBy:'manual',sortDirection:'asc'}]})}});
 await page.previewImport();page.removeImportRow({currentTarget:{dataset:{row:1}}});await page.commitImport();
 assert.deepEqual(Array.from(received[3][0].assetIds),[a.id]);
});
