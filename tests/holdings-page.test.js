const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const state={ok:true,revision:2,positions:[{assetId:'sh600519',id:'sh600519',name:'贵州茅台',code:'600519',market:'SH',kind:'stock',currency:'CNY',unit:'元/股',quantity:100,cost:800,averageCost:8,marketValue:1100,price:11,realized:0,unrealized:300,unrealizedRate:37.5,totalPnl:300,totalPnlRate:37.5,daily:100,sessionDate:'2026-10-29',note:'私人备注'}],currencies:[{currency:'CNY',cash:1000,cashTracked:true,complete:true,equity:2100,marketValue:1100,knownValue:1100,unrealized:300,realized:0,totalPnl:300,allocation:52.38,dailyGroups:[{date:'2026-10-29',value:100,complete:true}]}],entries:[{id:'a',logicalId:'a',version:1,sequence:1,type:'openingPosition',assetId:'sh600519',currency:'CNY',date:'2026-10-28',quantity:'100',cost:'800'}],assets:[{id:'sh600519',name:'贵州茅台',currency:'CNY',market:'SH',unit:'元/股'}],auditCount:1};
function load({hidden=false,ledger={},market={},portfolioApi={},preferences={hideAmounts:hidden}}={}){let page,confirm=true,calls=[],scrolls=[],sheets=[];const api={getTheme:()=> 'paper',applyChrome(){},chartColors:()=>({})};const wx={showActionSheet:o=>sheets.push(o),showToast(){},showModal:o=>{calls.push(o);o.success({confirm});},navigateTo:o=>calls.push(o),setClipboardData:o=>{calls.push(o);o.success&&o.success();},pageScrollTo:o=>scrolls.push(o),stopPullDownRefresh(){}};const clients={list:async()=>structuredClone(state),saveEntry:async e=>{calls.push(e);return structuredClone({...state,revision:3});},voidEntry:async()=>{calls.push('void');return structuredClone(state);},previewImport:async()=>({ok:true,previewHash:'hash',preview:structuredClone(state),previousCount:1}),importBackup:async()=>{calls.push('import');return structuredClone(state);},...ledger};if(!fs.existsSync('pages/holdings/holdings.js'))return{page:null};vm.runInNewContext(fs.readFileSync('pages/holdings/holdings.js','utf8'),{Page:p=>page=p,require:p=>p.includes('holdings-form')?require('../utils/holdings-form'):p.includes('ledger-client')?clients:p.includes('display-preferences')?{get:()=>({hideAmounts:preferences.hideAmounts,showTime:true,showNotes:true,showChange:true,quiet:false,compact:false}),colors:b=>b}:p.includes('portfolio-client')?{getCached:()=>({items:state.assets}),list:async()=>({items:state.assets}),add:async()=>({}),...portfolioApi}:p.includes('market-client')?{search:async()=>({assets:state.assets}),resolve:async()=>({asset:state.assets[0]}),...market}:api,wx,Date,console,Promise,setTimeout,clearTimeout});page.data=structuredClone(page.data);page.setData=(patch,done)=>{Object.assign(page.data,patch);if(done)done();};page.onLoad();return{page,calls,scrolls,sheets,confirm:v=>confirm=v};}
test('holdings page keeps draft across refresh and saves only explicit valid submit',async()=>{const f=load();assert.ok(f.page,'holdings page must exist');const p=f.page;await p.onShow();p.openEntry();p.setData({draft:{...state.entries[0],cost:'900'},editing:true});await p.reload();assert.equal(p.data.draft.cost,'900');assert.equal(f.calls.length,0);await p.saveEntry();assert.equal(f.calls.length,1);assert.equal(p.data.editing,false);});
test('hidden amounts cover summary, rows and transaction list while retaining clear entry editor',async()=>{const f=load({hidden:true});assert.ok(f.page);await f.page.onShow();assert.equal(f.page.data.summary.equityText,'••••');assert.equal(f.page.data.rows[0].valueText,'••••');assert.equal(f.page.data.rows[0].dailyText,'••••');assert.equal(f.page.data.historyRows[0].amountText,'••••');});
test('void confirmation cancellation and explicit import preview prevent accidental writes',async()=>{const f=load();assert.ok(f.page);await f.page.onShow();f.confirm(false);await f.page.voidEntry({currentTarget:{dataset:{id:'a'}}});assert.equal(f.calls.includes('void'),false);f.page.setData({backupText:'{"schemaVersion":1,"entries":[],"notes":{}}'});await f.page.previewImport();assert.ok(f.page.data.importPreview);assert.equal(f.calls.includes('import'),false);f.confirm(true);await f.page.confirmImport();assert.ok(f.calls.includes('import'));});
test('failed mutation preserves draft and exposes refresh conflict',async()=>{const f=load({ledger:{saveEntry:async()=>{throw Object.assign(Error('台账已更新'),{code:'revision-conflict'});}}});assert.ok(f.page);await f.page.onShow();f.page.openEntry();f.page.setData({draft:{...state.entries[0],cost:'900'}});await f.page.saveEntry();assert.equal(f.page.data.draft.cost,'900');assert.equal(f.page.data.editing,true);assert.equal(f.page.data.conflict,true);});
test('holdings template binds complete forms, history, private notes and explicit backup restore controls',()=>{const w=fs.readFileSync('pages/holdings/holdings.wxml','utf8');for(const name of ['saveEntry','editEntry','voidEntry','saveNote','searchAssets','selectAsset','previewImport','confirmImport','generateBackup','copyBackup','chooseBackup','saveBackupFile','changeSort','chooseCurrency'])assert.match(w,new RegExp('(?:bindtap|bindchange|bindconfirm)="'+name+'"'),name);assert.match(w,/<page-meta/);assert.match(w,/aria-label=/);assert.match(w,/期初/);assert.match(w,/最近交易日/);assert.match(w,/移动加权/);});
test('note conflict refresh preserves note draft and updates the revision used for explicit retry',async()=>{let sent;const f=load({ledger:{saveNote:async(id,note,revision)=>{sent={id,note,revision};return structuredClone({...state,revision:4});},list:async()=>structuredClone({...state,revision:3})}});assert.ok(f.page);await f.page.onShow();f.page.openNote({currentTarget:{dataset:{id:'sh600519'}}});f.page.setData({noteDraft:'保留这段草稿'});assert.equal(typeof f.page.refreshNoteRevision,'function');await f.page.refreshNoteRevision();await f.page.saveNote();assert.deepEqual(sent,{id:'sh600519',note:'保留这段草稿',revision:3});});
test('editing quantity or price never resubmits a stale calculated gross amount',async()=>{const trade={...state.entries[0],type:'buy',quantity:'100',price:'10',grossAmount:'1000',grossAmountMode:'auto',fee:'0'};const f=load({ledger:{list:async()=>structuredClone({...state,entries:[trade]})}});await f.page.onShow();f.page.editEntry({currentTarget:{dataset:{id:'a'}}});f.page.inputDraft({currentTarget:{dataset:{key:'price'}},detail:{value:'20'}});await f.page.saveEntry();assert.equal(f.calls[0].grossAmount,'');assert.equal(f.calls[0].grossAmountMode,'auto');});
test('changing quantity explicitly clears a prior manual gross amount with a visible warning',async()=>{const trade={...state.entries[0],type:'buy',quantity:'100',price:'10',grossAmount:'1001',grossAmountMode:'explicit',fee:'0'};const f=load({ledger:{list:async()=>structuredClone({...state,entries:[trade]})}});await f.page.onShow();f.page.editEntry({currentTarget:{dataset:{id:'a'}}});f.page.inputDraft({currentTarget:{dataset:{key:'quantity'}},detail:{value:'200'}});assert.equal(f.page.data.draft.grossAmount,'');assert.match(f.page.data.grossWarning,/手工|实际/);});
test('return sorting places cost-unknown ratios last and supports both floating and realized rates',async()=>{const ps=[{...state.positions[0],assetId:'a',unrealizedRate:-5,realizedRate:20},{...state.positions[0],assetId:'b',unrealizedRate:null,realizedRate:null},{...state.positions[0],assetId:'c',unrealizedRate:10,realizedRate:-10}];const f=load({ledger:{list:async()=>structuredClone({...state,positions:ps})}});await f.page.onShow();for(const[label,expected]of [['浮动收益率',['c','a','b']],['已实现收益率',['a','c','b']]]){const i=f.page.data.sortOptions.findIndex(x=>x.includes(label));assert.ok(i>=0,label);f.page.changeSort({detail:{value:i}});assert.deepEqual(Array.from(f.page.data.rows,r=>r.assetId),expected);}});
test('asset resolve does not change hidden page state after navigation',async()=>{let resolve;const f=load({market:{resolve:()=>new Promise(r=>resolve=r)}});await f.page.onShow();await f.page.openEntry();const pending=f.page.selectAsset({currentTarget:{dataset:{id:'sh600519'}}});f.page.onHide();const before=JSON.stringify(f.page.data);resolve({asset:state.assets[0]});await pending;assert.equal(JSON.stringify(f.page.data),before);});
test('an old selected asset or search response cannot overwrite a newer interaction',async()=>{const requests={};const f=load({market:{resolve:id=>new Promise(r=>requests[id]=r)}});await f.page.onShow();await f.page.openEntry();const first=f.page.selectAsset({currentTarget:{dataset:{id:'sh600519'}}}),second=f.page.selectAsset({currentTarget:{dataset:{id:'sh510300'}}});requests.sh510300({asset:{...state.assets[0],id:'sh510300'}});await second;requests.sh600519({asset:state.assets[0]});await first;assert.equal(f.page.data.draft.assetId,'sh510300');});
test('enabling hidden amounts rerenders old snapshot before an offline reload fails',async()=>{const preferences={hideAmounts:false};let offline=false;const f=load({preferences,ledger:{list:async()=>{if(offline)throw Error('offline');return structuredClone(state);}}});await f.page.onShow();assert.notEqual(f.page.data.rows[0].valueText,'••••');f.page.onHide();preferences.hideAmounts=true;offline=true;const reload=f.page.onShow();assert.equal(f.page.data.summary.equityText,'••••');assert.equal(f.page.data.rows[0].valueText,'••••');assert.equal(f.page.data.historyRows[0].amountText,'••••');await reload;assert.equal(f.page.data.rows[0].valueText,'••••');assert.equal(f.page.data.offline,true);});
test('old search response is invalidated when choosing an asset',async()=>{let release;const f=load({market:{search:()=>new Promise(r=>release=r)}});await f.page.onShow();await f.page.openEntry();f.page.inputKeyword({detail:{value:'stock'}});const pending=f.page.searchAssets();await f.page.selectAsset({currentTarget:{dataset:{id:'sh600519'}}});release({assets:[{...state.assets[0],id:'old-result'}]});await pending;assert.equal(f.page.data.searchResults.length,0);assert.equal(f.page.data.draft.assetId,'sh600519');});
test('calculation and capacity notes stay collapsed until an explicit accessible toggle',()=>{const f=load();assert.equal(f.page.data.explanationsExpanded,false);assert.equal(typeof f.page.toggleExplanations,'function');f.page.toggleExplanations();assert.equal(f.page.data.explanationsExpanded,true);f.page.toggleExplanations();assert.equal(f.page.data.explanationsExpanded,false);const w=fs.readFileSync('pages/holdings/holdings.wxml','utf8');assert.match(w,/aria-expanded="{{explanationsExpanded}}"/);assert.match(w,/wx:if="{{explanationsExpanded}}"/);assert.match(w,/移动加权平均成本/);assert.match(w,/1000条含修订流水/);const css=fs.readFileSync('pages/holdings/holdings.wxss','utf8');assert.match(css,/\.heading-row[^}]*\.text-button[^}]*width:auto/);});
test('position search matches name or code without changing summary and expansion survives rerender',async()=>{
 const {page:p}=load();await p.onShow();const equity=p.data.summary.equityText;
 p.inputPositionQuery({detail:{value:'600519'}});assert.equal(p.data.rows.length,1);
 p.togglePosition({currentTarget:{dataset:{id:'sh600519'}}});assert.equal(p.data.rows[0].expanded,true);
 p.inputPositionQuery({detail:{value:'不存在'}});assert.equal(p.data.rows.length,0);assert.equal(p.data.summary.equityText,equity);
 p.clearPositionQuery();assert.equal(p.data.rows[0].expanded,true);
});
test('history filters combine transaction type with asset name or code',async()=>{
 const {page:p}=load();await p.onShow();p.inputHistoryQuery({detail:{value:'600519'}});assert.equal(p.data.historyRows.length,1);
 p.changeHistoryType({detail:{value:2}});assert.equal(p.data.historyRows.length,0);
 p.clearHistoryFilters();assert.equal(p.data.historyRows.length,1);
});
test('refresh retains snapshot and ignores concurrent refresh attempts',async()=>{
 let release,count=0;const f=load({ledger:{list:async()=>{count++;if(count===1)return structuredClone(state);return new Promise(r=>release=r);}}});
 await f.page.onShow();const pending=f.page.reload();assert.equal(f.page.data.refreshing,true);assert.equal(f.page.data.rows.length,1);
 await f.page.reload();assert.equal(count,2);release(structuredClone(state));await pending;assert.equal(f.page.data.refreshing,false);
});
test('invalid form stays local and successful explicit save reports success',async()=>{
 const {page:p,calls}=load();await p.onShow();await p.openEntry();await p.saveEntry();assert.ok(p.data.formErrors.assetId);assert.equal(calls.length,0);
 p.setData({draft:{...state.entries[0],cost:'900'}});await p.saveEntry();assert.equal(p.data.editing,false);assert.match(p.data.successText,/保存/);
});
test('live editor preview updates after input and missing fields clear after correction',async()=>{
 const {page:p}=load();await p.onShow();await p.openEntry({currentTarget:{dataset:{id:'sh600519',type:'buy'}}});
 await p.saveEntry();assert.ok(p.data.formErrors.quantity);
 for(const [key,value] of [['quantity','2'],['price','10'],['fee','1']])p.inputDraft({currentTarget:{dataset:{key}},detail:{value}});
 assert.equal(p.data.entryPreview.cashText,'−21.00');assert.equal(Object.keys(p.data.formErrors).length,0);
});
test('overview defaults to collapsed and toggles without changing summary',async()=>{
 const {page:p}=load();await p.onShow();assert.equal(p.data.overviewExpanded,false);p.toggleOverview();assert.equal(p.data.overviewExpanded,true);
 const value=p.data.summary.equityText;p.toggleOverview();assert.equal(p.data.summary.equityText,value);
});
test('opening a note brings its editor into view',async()=>{
 const {page:p,scrolls}=load();await p.onShow();p.openNote({currentTarget:{dataset:{id:'sh600519'}}});
 assert.equal(p.data.noteEditing,true);assert.ok(scrolls.some(c=>c.selector==='#note-editor'));
});
test('primary entry directly opens the appropriate form and resumes a retained draft',async()=>{
 const {page:p}=load();await p.onShow();await p.startEntry();assert.equal(p.data.editing,true);assert.equal(p.data.draft.type,'buy');
 p.inputDraft({currentTarget:{dataset:{key:'quantity'}},detail:{value:'25'}});p.cancelEntry();await p.startEntry();assert.equal(p.data.draft.quantity,'25');assert.equal(p.data.editing,true);
});
test('first entry defaults to existing holdings when this currency has no assets',async()=>{
 const {page:p}=load({ledger:{list:async()=>structuredClone({...state,positions:[],entries:[],assets:[],currencies:[]})}});await p.onShow();await p.startEntry();assert.equal(p.data.draft.type,'openingPosition');
});
test('returning from entry preserves the session draft and revision for explicit resume',async()=>{
 const {page:p,calls}=load();await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'deposit'}}});
 p.inputDraft({currentTarget:{dataset:{key:'amount'}},detail:{value:'1234'}});p.cancelEntry();
 assert.equal(p.data.hasEntryDraft,true);assert.equal(p.data.editing,false);
 p.resumeEntry();assert.equal(p.data.editing,true);assert.equal(p.data.view,'entry');assert.equal(p.data.draft.amount,'1234');assert.equal(calls.length,0);
 await p.saveEntry();assert.equal(p.data.hasEntryDraft,false);assert.equal(calls[0].amount,'1234');
});
test('asset buy and sell shortcuts skip the chooser and retain asset context',async()=>{
 const {page:p}=load();await p.onShow();
 for(const type of ['buy','sell']){await p.openEntry({currentTarget:{dataset:{id:'sh600519',type}}});assert.equal(p.data.editing,true);assert.equal(p.data.view,'entry');assert.equal(p.data.draft.assetId,'sh600519');}
});
test('draft replacement is also confirmed from asset shortcuts',async()=>{
 const f=load(),p=f.page;await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'deposit'}}});p.inputDraft({currentTarget:{dataset:{key:'amount'}},detail:{value:'100'}});p.cancelEntry();f.confirm(false);
 await p.openEntry({currentTarget:{dataset:{id:'sh600519',type:'buy'}}});assert.equal(p.data.hasEntryDraft,true);assert.equal(p.data.draft.amount,'100');assert.equal(p.data.editing,false);
});
test('editing a historical entry asks before replacing a retained draft',async()=>{
 const f=load(),p=f.page;await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'deposit'}}});p.inputDraft({currentTarget:{dataset:{key:'amount'}},detail:{value:'100'}});p.cancelEntry();f.confirm(false);
 await p.editEntry({currentTarget:{dataset:{id:'a'}}});assert.equal(p.data.draft.type,'deposit');assert.equal(p.data.hasEntryDraft,true);assert.equal(p.data.editing,false);
});
test('resumed draft retains its original revision after a newer snapshot is loaded',async()=>{
 let revision=2,sent;const {page:p}=load({ledger:{list:async()=>structuredClone({...state,revision}),saveEntry:async(entry,rev)=>{sent=rev;return structuredClone({...state,revision:4});}}});
 await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'deposit'}}});p.inputDraft({currentTarget:{dataset:{key:'amount'}},detail:{value:'100'}});p.cancelEntry();revision=3;await p.reload();p.resumeEntry();await p.saveEntry();assert.equal(sent,2);
});

test('cash entry respects whether opening cash has already been recorded',async()=>{
 const {page:p}=load();await p.onShow();await p.manageCash();assert.equal(p.data.draft.type,'deposit');assert.ok(!p.data.formTypes.some(t=>t.value==='openingCash'));
 const empty=load({ledger:{list:async()=>structuredClone({...state,currencies:[]})}}).page;await empty.onShow();await empty.manageCash();assert.equal(empty.data.draft.type,'openingCash');assert.ok(empty.data.formTypes.some(t=>t.value==='openingCash'));
});
test('only one position expands at a time and collapse survives refresh',async()=>{
 const positions=[...state.positions,{...state.positions[0],assetId:'sh510300',name:'沪深300'}];const {page:p}=load({ledger:{list:async()=>structuredClone({...state,positions})}});await p.onShow();
 p.togglePosition({currentTarget:{dataset:{id:'sh600519'}}});p.togglePosition({currentTarget:{dataset:{id:'sh510300'}}});assert.equal(p.data.rows.filter(r=>r.expanded).length,1);assert.equal(p.data.rows.find(r=>r.assetId==='sh510300').expanded,true);
});
test('untracked cash shows holdings valuation instead of pretending total assets are known',async()=>{
 const {page:p}=load({ledger:{list:async()=>structuredClone({...state,currencies:[{...state.currencies[0],cashTracked:false,equity:null}]})}});await p.onShow();assert.equal(p.data.summary.primaryLabel,'持仓市值');assert.equal(p.data.summary.primaryText,'1,100.00');
});
test('sell all fills actual quantity only and never invents an execution price',async()=>{
 const {page:p}=load();await p.onShow();await p.openEntry({currentTarget:{dataset:{id:'sh600519',type:'sell'}}});p.fillAllQuantity();assert.equal(p.data.draft.quantity,'100');assert.equal(p.data.draft.price,'');
});
test('switching entry type clears irrelevant monetary fields and stale manual gross',async()=>{
 const {page:p}=load();await p.onShow();await p.openEntry({currentTarget:{dataset:{id:'sh600519',type:'buy'}}});p.setData({draft:{...p.data.draft,quantity:'5',price:'10',grossAmount:'50',grossAmountMode:'explicit',fee:'2'}});
 p.selectFormType({currentTarget:{dataset:{type:'openingPosition'}}});assert.equal(p.data.draft.grossAmount,'');assert.equal(p.data.draft.price,'');assert.equal(p.data.isOpening,true);assert.equal(p.data.draft.assetId,'sh600519');
});
test('more menu routes history without losing selected currency or filters',async()=>{
 const {page:p,sheets}=load();await p.onShow();p.inputPositionQuery({detail:{value:'茅台'}});p.showMore();assert.ok(sheets[0].itemList.includes('交易记录'));sheets[0].success({tapIndex:0});assert.equal(p.data.view,'history');p.backToHoldings();assert.equal(p.data.view,'overview');assert.equal(p.data.positionQuery,'茅台');
});
test('background refresh never clears an unresolved draft conflict',async()=>{
 let writes=0;const {page:p}=load({ledger:{saveEntry:async()=>{writes++;throw Object.assign(Error('changed'),{code:'revision-conflict'});}}});await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'deposit'}}});p.inputDraft({currentTarget:{dataset:{key:'amount'}},detail:{value:'100'}});await p.saveEntry();assert.equal(p.data.conflict,true);await p.reload();assert.equal(p.data.conflict,true);await p.saveEntry();assert.equal(writes,1);await p.refreshDraftRevision();assert.equal(p.data.conflict,false);
});
test('cash currency switch never offers opening cash for an already tracked ledger',async()=>{
 const {page:p}=load();await p.onShow();p.chooseCurrency({currentTarget:{dataset:{currency:'HKD'}}});await p.manageCash();assert.equal(p.data.draft.type,'openingCash');p.changeDraftCurrency({detail:{value:0}});assert.equal(p.data.draft.type,'deposit');assert.ok(!p.data.formTypes.some(t=>t.value==='openingCash'));
});
test('editing a selected asset keeps search collapsed until explicitly changed',async()=>{
 const {page:p}=load();await p.onShow();await p.openEntry({currentTarget:{dataset:{id:'sh600519',type:'buy'}}});assert.equal(p.data.assetSearchOpen,false);p.changeAsset();assert.equal(p.data.assetSearchOpen,true);await p.selectAsset({currentTarget:{dataset:{id:'sh600519'}}});assert.equal(p.data.assetSearchOpen,false);
});
test('editing an ordinary deposit cannot turn it into a second opening cash record',async()=>{
 const entry={...state.entries[0],type:'deposit',assetId:'',amount:'100'};const {page:p}=load({ledger:{list:async()=>structuredClone({...state,entries:[entry]})}});await p.onShow();await p.editEntry({currentTarget:{dataset:{id:'a'}}});assert.ok(!p.data.formTypes.some(t=>t.value==='openingCash'));
});

test('opening the editor uses cached candidates without requesting portfolio remotely',async()=>{
 let remote=0;const cached={...state.assets[0],id:'sh510300',name:'沪深300'};
 const {page:p}=load({portfolioApi:{getCached:()=>({items:[cached]}),list:async()=>{remote++;throw Error('timeout');}}});await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'buy'}}});assert.equal(remote,0);assert.equal(p.data.quickAssets.length,2);assert.ok(p.data.quickAssets.some(a=>a.id==='sh510300'));
});
test('missing cached watchlist never prevents recording or retaining ledger candidates',async()=>{
 const {page:p}=load({portfolioApi:{getCached:()=>null,list:async()=>{throw Error('must not call');}}});await p.onShow();await p.openEntry({currentTarget:{dataset:{type:'buy'}}});assert.equal(p.data.editing,true);assert.equal(p.data.quickAssets[0].id,'sh600519');
});
