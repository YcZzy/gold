const ledger=require('../../utils/ledger-client');
const portfolio=require('../../utils/portfolio-client');
const market=require('../../utils/market-client');
const theme=require('../../utils/theme');
const display=require('../../utils/display-preferences');
const TYPES=[{value:'openingPosition',label:'期初已有持仓'},{value:'buy',label:'买入'},{value:'sell',label:'卖出'},{value:'openingCash',label:'期初现金'},{value:'deposit',label:'现金入金'},{value:'withdrawal',label:'现金出金'},{value:'income',label:'现金分红 / 收入'},{value:'expense',label:'独立费用'},{value:'split',label:'拆股 / 合股'}];
const LABELS=Object.fromEntries(TYPES.map(t=>[t.value,t.label]));
const MONEY_KEYS=['price','cost','averageCost','marketValue','realized','unrealized','totalPnl','daily'];
function number(value,digits=2){return value==null||!Number.isFinite(value)?'—':value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});}
function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function assetToday(asset){try{return asset&&asset.timezone?new Intl.DateTimeFormat('en-CA',{timeZone:asset.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):today();}catch(_){return today();}}
function modal(options){return new Promise(resolve=>wx.showModal({...options,success:r=>resolve(!!r.confirm),fail:()=>resolve(false)}));}
Page({
 data:{theme:theme.getTheme(),preferences:display.get(),loading:true,busy:false,loaded:false,errorText:'',offline:false,conflict:false,tab:'positions',explanationsExpanded:false,currency:'CNY',currencyOptions:['CNY','HKD','USD'],sortIndex:0,sortOptions:['市值从高到低','浮动盈亏从高到低','浮动收益率从高到低','已实现收益率从高到低','名称'],showClosed:false,rows:[],historyRows:[],summary:{},revision:0,auditCount:0,operationCount:0,editing:false,grossWarning:'',draft:{},editId:'',types:TYPES,typeIndex:0,requiresAsset:true,isTrade:false,isOpening:true,isCash:false,isSplit:false,selectedAsset:null,keyword:'',searchResults:[],watchlist:[],searchBusy:false,noteEditing:false,noteConflict:false,noteAssetId:'',noteDraft:'',backupText:'',importPreview:null,exportReady:false},
 onLoad(){this._alive=true;this._request=0;this.setData({theme:theme.getTheme()});theme.applyChrome(this.data.theme);},
 async onShow(){this._visible=true;this._alive=true;this.setData({theme:theme.getTheme(),preferences:display.get(),searchBusy:false});this.render();theme.applyChrome(this.data.theme);return this.reload();},
 onHide(){this._visible=false;this._request++;this._assetEpoch=(this._assetEpoch||0)+1;},
 onUnload(){this._alive=false;this.onHide();},
 async onPullDownRefresh(){try{await this.reload();}finally{if(wx.stopPullDownRefresh)wx.stopPullDownRefresh();}},
 async reload(){
  const request=++this._request;this.setData({loading:!this.data.loaded});
  try{const r=await ledger.list();if(!this._alive||request!==this._request)return;this.applySnapshot(r);this.setData({loading:false,offline:false,errorText:'',conflict:false});}
  catch(e){if(this._alive&&request===this._request)this.setData({loading:false,offline:true,errorText:e.hint||e.message||'台账暂不可用'});}
 },
 applySnapshot(r){if(this._snapshot&&r.revision<this._snapshot.revision)return;this._snapshot=r;this.setData({revision:r.revision,loaded:true,auditCount:r.auditCount||0,operationCount:r.operationCount||0,quoteWarning:r.quoteWarning||''});this.render();},
 amount(value,digits=2){return this.data.preferences.hideAmounts?'••••':number(value,digits);},
 render(){
  const r=this._snapshot;if(!r)return;const c=r.currencies.find(c=>c.currency===this.data.currency);
  const summary=c?{currency:c.currency,cashText:c.cashTracked?this.amount(c.cash):'未设置',equityText:this.amount(c.equity),valueText:this.amount(c.marketValue),knownValueText:this.amount(c.knownValue),unrealizedText:this.amount(c.unrealized),realizedText:this.amount(c.realized),totalText:this.amount(c.totalPnl),rateText:this.data.preferences.hideAmounts?'••••':c.totalPnlRate==null?'—':number(c.totalPnlRate)+'%',floatRateText:this.data.preferences.hideAmounts?'••••':c.unrealizedRate==null?'—':number(c.unrealizedRate)+'%',allocationText:this.data.preferences.hideAmounts?'••••':c.allocation==null?'—':number(c.allocation)+'%',complete:c.complete,cashTracked:c.cashTracked,coverage:`${c.valuedCount||0}/${c.positionCount||0}`,days:(c.dailyGroups||[]).map(d=>({date:d.date,valueText:this.amount(d.value),complete:d.complete}))}:{currency:this.data.currency,cashText:'未设置',equityText:'—',valueText:'—',knownValueText:'—',unrealizedText:'—',realizedText:'—',totalText:'—',rateText:'—',floatRateText:'—',allocationText:'—',complete:true,cashTracked:false,coverage:'0/0',days:[]};
  let ps=r.positions.filter(p=>p.currency===this.data.currency&&(this.data.showClosed||p.quantity>0));
  const sortKey=['marketValue','unrealized','unrealizedRate','realizedRate'][this.data.sortIndex];
  ps.sort((a,b)=>!sortKey?a.name.localeCompare(b.name,'zh'):a[sortKey]==null?(b[sortKey]==null?0:1):b[sortKey]==null?-1:b[sortKey]-a[sortKey]);
  const rows=ps.map(p=>{const row={assetId:p.assetId,name:p.name,code:p.code,market:p.market,currency:p.currency,unit:p.unit,quantityText:number(p.quantity,6).replace(/\.?0+$/,'')||'0',note:p.note,closed:p.quantity===0,sessionDate:p.sessionDate||'交易日未知',dailyReason:p.dailyReason||'',source:p.source||'行情缺失',stale:p.stale,status:p.status,sourceTimeText:p.sourceTime?new Date(p.sourceTime).toLocaleString('zh-CN'):'时间未知',gainClass:this.data.preferences.quiet?'neutral':p.unrealized>0?'up':p.unrealized<0?'down':'neutral',realizedRateText:this.data.preferences.hideAmounts?'••••':p.realizedRate==null?'—':number(p.realizedRate)+'%',rateText:this.data.preferences.hideAmounts?'••••':p.unrealizedRate==null?'—':number(p.unrealizedRate)+'%',totalRateText:this.data.preferences.hideAmounts?'••••':p.totalPnlRate==null?'—':number(p.totalPnlRate)+'%'};for(const key of MONEY_KEYS)row[key+'Text']=this.amount(p[key],key==='price'||key==='averageCost'?4:2);row.valueText=row.marketValueText;return row;});
  const historyRows=[...(r.entries||[])].filter(e=>e.currency===this.data.currency).reverse().map(e=>({logicalId:e.logicalId,name:(r.assets.find(a=>a.id===e.assetId)||{}).name||e.currency,typeText:LABELS[e.type]||e.type,date:e.date,sequence:e.sequence,version:e.version,quantityText:e.quantity||'',amountText:this.data.preferences.hideAmounts?'••••':e.type==='split'?`${e.denominator} → ${e.numerator}`:e.amount!=null?e.amount:e.cost!=null?e.cost:e.grossAmount||'—',feeText:this.data.preferences.hideAmounts?'••••':e.fee||'0',note:e.note||''}));
  const privacyPatch=this.data.preferences.hideAmounts&&this.data.importPreview?{importPreview:{...this.data.importPreview,currencies:this.data.importPreview.currencies.map(c=>({...c,cashText:'••••',valueText:'••••'}))}}:{};
  this.setData({summary,rows,historyRows,...privacyPatch});
 },
 toggleExplanations(){this.setData({explanationsExpanded:!this.data.explanationsExpanded});},
 setTab(e){this.setData({tab:e.currentTarget.dataset.tab});},
 chooseCurrency(e){this.setData({currency:e.currentTarget.dataset.currency});this.render();},
 changeSort(e){this.setData({sortIndex:Number(e.detail.value)});this.render();},
 toggleClosed(e){this.setData({showClosed:!!e.detail.value});this.render();},
 async openEntry(e){
  if(this.data.busy)return;const ds=e&&e.currentTarget&&e.currentTarget.dataset||{},type=ds.type||'openingPosition',assetId=ds.id||'';
  const editorEpoch=this._assetEpoch=(this._assetEpoch||0)+1;this._draftRevision=this.data.revision;
  const selectedAsset=this._snapshot&&this._snapshot.assets.find(a=>a.id===assetId)||null;
  this.setData({editing:true,editId:'',draft:{type,date:assetToday(selectedAsset),currency:selectedAsset?selectedAsset.currency:this.data.currency,assetId,quantity:'',price:'',fee:'0',cost:'',amount:'',grossAmount:'',grossAmountMode:'auto',note:'',numerator:'2',denominator:'1'},selectedAsset,grossWarning:'',searchBusy:false,errorText:'',conflict:false,keyword:'',searchResults:[]});this.formType(type);if(wx.pageScrollTo)wx.pageScrollTo({scrollTop:0,duration:0});
  try{const r=await portfolio.list();if(this._alive&&this._visible&&this.data.editing&&editorEpoch===this._assetEpoch)this.setData({watchlist:r.items||[]});}catch(_){if(this._alive&&this._visible&&this.data.editing&&editorEpoch===this._assetEpoch)this.setData({watchlist:[]});}
 },
 formType(type){this.setData({typeIndex:TYPES.findIndex(t=>t.value===type),requiresAsset:['openingPosition','buy','sell','split','income'].includes(type),isTrade:['buy','sell'].includes(type),isOpening:type==='openingPosition',isCash:['openingCash','deposit','withdrawal','income','expense'].includes(type),isSplit:type==='split'});},
 changeType(e){this._assetEpoch=(this._assetEpoch||0)+1;this.setData({searchBusy:false});const type=TYPES[Number(e.detail.value)].value;this.setData({draft:{...this.data.draft,type,assetId:['openingCash','deposit','withdrawal','expense'].includes(type)?'':this.data.draft.assetId},selectedAsset:['openingCash','deposit','withdrawal','expense'].includes(type)?null:this.data.selectedAsset});this.formType(type);},
 inputDraft(e){const key=e.currentTarget.dataset.key;if(!['quantity','price','grossAmount','fee','cost','amount','date','note','numerator','denominator'].includes(key))return;this._assetEpoch=(this._assetEpoch||0)+1;const draft={...this.data.draft,[key]:e.detail.value};let grossWarning=this.data.grossWarning;
  if(['quantity','price'].includes(key)){if(this.data.draft.grossAmount&&(this.data.draft.grossAmountMode||'explicit')==='explicit')grossWarning='已清空原手工成交金额。请按新数量和单价重新填写实际金额，留空则自动计算数量 × 单价。';draft.grossAmount='';draft.grossAmountMode='auto';}
  if(key==='grossAmount'){draft.grossAmountMode=e.detail.value===''?'auto':'explicit';grossWarning=e.detail.value===''?'':'实际成交金额将作为成本与现金依据，单价和数量仅作记录，请核对三者。';}
  this.setData({draft,grossWarning,searchBusy:false});},
 changeDraftCurrency(e){this.setData({draft:{...this.data.draft,currency:this.data.currencyOptions[Number(e.detail.value)]}});},
 cancelEntry(){if(this.data.busy)return;this._assetEpoch=(this._assetEpoch||0)+1;this.setData({editing:false,searchBusy:false,errorText:'',conflict:false});},
 inputKeyword(e){this._assetEpoch=(this._assetEpoch||0)+1;this.setData({keyword:e.detail.value,searchResults:[],searchBusy:false});},
 async searchAssets(){
  if(!this.data.keyword.trim())return;const request=this._assetEpoch=(this._assetEpoch||0)+1;this.setData({searchBusy:true,errorText:''});
  try{const r=await market.search(this.data.keyword.trim());if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({searchResults:r.assets||r.items||[]});}catch(e){if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({errorText:e.message});}finally{if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({searchBusy:false});}
 },
 async selectAsset(e){
  const id=e.currentTarget.dataset.id,request=this._assetEpoch=(this._assetEpoch||0)+1;const active=()=>this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch;this.setData({searchBusy:true,errorText:''});
  try{const r=await market.resolve(id);if(active())this.setData({selectedAsset:r.asset,draft:{...this.data.draft,assetId:r.asset.id,currency:r.asset.currency,date:this.data.draft.date===today()?assetToday(r.asset):this.data.draft.date},keyword:'',searchResults:[]});}catch(e){if(active())this.setData({errorText:e.message});}finally{if(active())this.setData({searchBusy:false});}
 },
 async saveEntry(){
  if(this.data.busy)return;const draft={...this.data.draft};
  if(this.data.requiresAsset&&!draft.assetId){this.setData({errorText:'请先选择标的'});return;}
  this.setData({busy:true,errorText:'',conflict:false});
  try{const r=await ledger.saveEntry(draft,this._draftRevision==null?this.data.revision:this._draftRevision,this.data.editId||undefined);if(!this._alive)return;this.applySnapshot(r);this.setData({editing:false,offline:false});}
  catch(e){if(this._alive)this.setData({errorText:e.hint||e.message,conflict:e.code==='revision-conflict'});}finally{if(this._alive)this.setData({busy:false});}
 },
 async refreshDraftRevision(){await this.reload();if(!this.data.offline){this._draftRevision=this.data.revision;this.setData({conflict:false,errorText:'已载入最新台账；草稿保留，请核对后重新保存。'});}},
 editEntry(e){
  if(this.data.busy)return;const entry=this._snapshot.entries.find(x=>x.logicalId===e.currentTarget.dataset.id);if(!entry)return;
  this._assetEpoch=(this._assetEpoch||0)+1;this._draftRevision=this.data.revision;const draft={...entry};if(draft.grossAmountMode==='auto')draft.grossAmount='';this.setData({editing:true,searchBusy:false,grossWarning:draft.grossAmount?'该笔使用手工成交金额作为成本与现金依据；修改数量或单价将清空此金额，请重新核对。':'',editId:entry.logicalId,draft,selectedAsset:this._snapshot.assets.find(a=>a.id===entry.assetId)||null,errorText:'',conflict:false,keyword:'',searchResults:[]});this.formType(entry.type);if(wx.pageScrollTo)wx.pageScrollTo({scrollTop:0,duration:0});
 },
 async voidEntry(e){
  if(this.data.busy)return;const id=e.currentTarget.dataset.id;
  const confirmed=await modal({title:'撤销这笔流水？',content:'将重算之后全部持仓、现金与已实现盈亏。原记录保留审计；若造成历史超卖或现金不足，将拒绝整次撤销。',confirmText:'确认撤销',confirmColor:'#9a4b12'});if(!confirmed||!this._alive)return;
  this.setData({busy:true,errorText:''});try{const r=await ledger.voidEntry(id,this.data.revision);if(this._alive)this.applySnapshot(r);}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}
 },
 openNote(e){const id=e.currentTarget.dataset.id;this._noteRevision=this.data.revision;this.setData({noteEditing:true,noteAssetId:id,noteDraft:(this._snapshot.notes||{})[id]||'',noteConflict:false,errorText:''});},
 async refreshNoteRevision(){await this.reload();if(!this.data.offline){this._noteRevision=this.data.revision;this.setData({noteConflict:false,errorText:'已读取最新台账，备注草稿保留，请核对后保存。'});}},
 inputNote(e){this.setData({noteDraft:e.detail.value});},
 cancelNote(){if(!this.data.busy)this.setData({noteEditing:false});},
 async saveNote(){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{const r=await ledger.saveNote(this.data.noteAssetId,this.data.noteDraft,this._noteRevision);if(this._alive){this.applySnapshot(r);this.setData({noteEditing:false});}}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message,noteConflict:e.code==='revision-conflict'});}finally{if(this._alive)this.setData({busy:false});}},
 openDetail(e){wx.navigateTo({url:'/pages/detail/detail?assetId='+encodeURIComponent(e.currentTarget.dataset.id)});},
 async follow(e){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{await portfolio.add(e.currentTarget.dataset.id);wx.showToast({title:'已加入自选',icon:'success'});}catch(e){this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}},
 inputBackup(e){this._importBackup=null;this.setData({backupText:e.detail.value,importPreview:null,exportReady:false});},
 async generateBackup(){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{const r=await ledger.exportBackup();if(this._alive)this.setData({backupText:JSON.stringify(r.backup,null,2),exportReady:true,importPreview:null});}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}},
 copyBackup(){if(!this.data.backupText)return;wx.setClipboardData({data:this.data.backupText,success:()=>wx.showToast({title:'备份已复制',icon:'success'})});},
 async chooseBackup(){
  if(this.data.busy||!wx.chooseMessageFile||!wx.getFileSystemManager){this.setData({errorText:'当前环境不支持文件选择，请将JSON内容粘贴到文本框'});return;}
  wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:r=>{const file=r.tempFiles&&r.tempFiles[0];if(!file)return;if(file.size>512*1024){this.setData({errorText:'备份不能超过512KB'});return;}wx.getFileSystemManager().readFile({filePath:file.path,encoding:'utf8',success:x=>{if(this._alive){this._importBackup=null;this.setData({backupText:x.data,importPreview:null,exportReady:false,errorText:''});}},fail:()=>this.setData({errorText:'读取失败，请粘贴JSON内容'})});},fail:()=>{}});
 },
 async saveBackupFile(){
  if(!this.data.exportReady||!this.data.backupText)return;
  if(!wx.getFileSystemManager||!wx.env||!wx.env.USER_DATA_PATH){this.setData({errorText:'当前环境不支持保存文件，请复制备份'});return;}
  const filePath=wx.env.USER_DATA_PATH+'/holdings-backup-'+Date.now()+'.json';
  wx.getFileSystemManager().writeFile({filePath,data:this.data.backupText,encoding:'utf8',success:()=>{if(wx.shareFileMessage)wx.shareFileMessage({filePath,fileName:'holdings-backup.json',fail:()=>this.setData({errorText:'分享未完成，备份仍可复制'})});else this.setData({errorText:'备份文件已生成；当前环境不支持分享，请复制JSON保存'});},fail:()=>this.setData({errorText:'文件生成失败，请复制备份'})});
 },
 async previewImport(){
  if(this.data.busy)return;this.setData({busy:true,errorText:'',importPreview:null});
  try{const backup=JSON.parse(this.data.backupText);const r=await ledger.previewImport(backup,this.data.revision);if(!this._alive)return;this._importBackup=backup;this._importHash=r.previewHash;this._importRevision=r.revision;const hidden=this.data.preferences.hideAmounts;
   this.setData({importPreview:{previousCount:r.previousCount,entryCount:r.preview.entries.length,auditCount:r.preview.auditCount,assetCount:r.preview.assets.length,currencies:r.preview.currencies.map(c=>({currency:c.currency,cashText:hidden?'••••':number(c.cash),valueText:hidden?'••••':number(c.marketValue),complete:c.complete}))}});
  }catch(e){if(this._alive)this.setData({errorText:e.hint||e.message||'JSON格式无效'});}finally{if(this._alive)this.setData({busy:false});}
 },
 async confirmImport(){
  if(this.data.busy||!this.data.importPreview||!this._importBackup)return;
  const confirm=await modal({title:'恢复这份台账备份？',content:'将原子替换当前手工持仓、流水和持仓备注。请先导出当前台账留存。自选、提醒和会员权限不在恢复范围。',confirmText:'确认恢复'});if(!confirm||!this._alive)return;
  this.setData({busy:true,errorText:''});try{const r=await ledger.importBackup(this._importBackup,this._importRevision,this._importHash);if(this._alive){this.applySnapshot(r);this.setData({importPreview:null,backupText:'',exportReady:false});this._importBackup=null;}}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}
 }
});
