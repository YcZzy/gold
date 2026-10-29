const portfolio=require('../../utils/portfolio-client');
const market=require('../../utils/market-client');
const transfer=require('../../utils/data-transfer');
const display=require('../../utils/display-preferences');
const theme=require('../../utils/theme');
const invoke=(fn,args)=>new Promise((resolve,reject)=>fn({...args,success:resolve,fail:reject}));
Page({
  data:{theme:theme.getTheme(),items:[],groups:[],revision:0,busy:false,errorText:'',notice:'',offline:false,
    raw:'',preview:[],pendingGroupCount:0,groupEditing:false,groupDraft:{name:'',assetIds:[],sortBy:'manual',sortDirection:'asc'},
    memberOptions:[],display:display.get(),exportText:'',exportPath:'',exportFormat:'json',
    sortOptions:['手动','价格','涨跌幅','成交额'],sortIndex:0},
  onLoad(){this._alive=true;this._visible=true;theme.applyChrome(this.data.theme);},
  async onShow(){this._visible=true;this.setData({theme:theme.getTheme(),display:display.get(wx)});theme.applyChrome(this.data.theme);
    if(this._pendingFile && this._pendingFile.request===this._fileRequest){this.onImportInput({detail:{value:this._pendingFile.text}});this._pendingFile=null;}
    await this.loadState();},
  onHide(){if(this._alive)this.setData({busy:false});this._visible=false;this._request=(this._request||0)+1;this._previewRequest=(this._previewRequest||0)+1;},
  onUnload(){this.onHide();this._alive=false;this._fileRequest=(this._fileRequest||0)+1;},
  isCurrent(request){return this._alive && this._visible && request===this._request;},
  apply(s){this._state=s;this.setData({items:s.items,groups:s.groups||[],revision:s.revision,offline:!!s.offline});},
  async loadState(){
    const request=this._request=(this._request||0)+1;
    try{const s=await portfolio.list();if(this.isCurrent(request))this.apply(s);}
    catch(e){if(this.isCurrent(request))this.setData({errorText:e.message||'自选加载失败'});}
  },
  editGroup(e){
    if(this.data.busy)return;
    const group=this.data.groups.find(g=>g.id===e.currentTarget.dataset.id)||{name:'',assetIds:[],sortBy:'manual',sortDirection:'asc'};
    this._groupRevision=this.data.revision;
    this.setData({groupEditing:true,groupDraft:{...group,assetIds:[...group.assetIds]},
      memberOptions:this.data.items.map(a=>({...a,checked:group.assetIds.includes(a.id)})),
      sortIndex:['manual','price','changePct','amount'].indexOf(group.sortBy),errorText:''});
  },
  onGroupName(e){this.setData({groupDraft:{...this.data.groupDraft,name:e.detail.value}});},
  onGroupMembers(e){this.setData({groupDraft:{...this.data.groupDraft,assetIds:e.detail.value}});},
  onGroupSort(e){const i=Number(e.detail.value);this.setData({sortIndex:i,groupDraft:{...this.data.groupDraft,sortBy:['manual','price','changePct','amount'][i]}});},
  onGroupDirection(e){this.setData({groupDraft:{...this.data.groupDraft,sortDirection:e.detail.value?'desc':'asc'}});},
  cancelGroup(){if(!this.data.busy)this.setData({groupEditing:false,errorText:''});},
  async saveGroup(){
    if(this.data.busy)return;
    if(!this.data.groupDraft.name.trim())return this.setData({errorText:'请输入分组名称'});
    this.setData({busy:true,errorText:''});const request=this._request=(this._request||0)+1;
    try{const s=await portfolio.saveGroup(this.data.groupDraft,this._groupRevision);if(this.isCurrent(request)){this.apply(s);this.setData({groupEditing:false,notice:'分组已保存'});}}
    catch(e){if(this.isCurrent(request))this.setData({errorText:e.message});}
    finally{if(this.isCurrent(request))this.setData({busy:false});}
  },
  deleteGroup(e){
    if(this.data.busy)return;
    const id=e.currentTarget.dataset.id;
    wx.showModal({title:'删除分组',content:'仅删除此分组，自选、备注及提醒仍会保留。',success:async r=>{
      if(!r.confirm || this.data.busy || !this._visible)return;this.setData({busy:true,errorText:''});
      const request=this._request=(this._request||0)+1;
      try{const s=await portfolio.deleteGroup(id,this.data.revision);if(this.isCurrent(request)){this.apply(s);this.setData({notice:'分组已删除'});}}
      catch(e){if(this.isCurrent(request))this.setData({errorText:e.message});}finally{if(this.isCurrent(request))this.setData({busy:false});}
    }});
  },
  changeDisplay(e){
    try{const next=display.save({[e.currentTarget.dataset.key]:e.detail.value},wx);this.setData({display:next,notice:'显示设置已保存到本设备',errorText:''});}
    catch(e){this.setData({errorText:e.message||'设备保存失败'});}
  },
  onImportInput(e){
    this._fileRequest=(this._fileRequest||0)+1;
    this._previewRequest=(this._previewRequest||0)+1;
    this.setData({raw:e.detail.value,preview:[],pendingGroupCount:0,errorText:'',notice:''});
  },
  async chooseFile(){
    if(this.data.busy)return;
    const request=this._fileRequest=(this._fileRequest||0)+1;
    try{
      if(!wx.chooseMessageFile)throw Error('当前环境不支持选文件，请粘贴内容导入');
      const result=await invoke(wx.chooseMessageFile,{count:1,type:'file',extension:['json','csv','txt']});
      const file=result.tempFiles[0];if(!file || file.size>262144)throw Error('文件大小不能超过 256 KB');
      const manager=wx.getFileSystemManager();
      const content=await invoke(manager.readFile.bind(manager),{filePath:file.path,encoding:'utf8'});
      if(this._alive && request===this._fileRequest){
        if(this._visible)this.onImportInput({detail:{value:content.data}});
        else this._pendingFile={request,text:content.data};
      }
    }catch(e){if(this._alive && this._visible && request===this._fileRequest && !/cancel/.test(e.errMsg||''))this.setData({errorText:e.message||'文件读取失败'});}
  },
  async previewImport(){
    if(this.data.busy)return;
    let records;try{records=transfer.parse(this.data.raw);}catch(e){return this.setData({errorText:e.message});}
    this._importGroupSettings=records.groupSettings||[];
    const request=this._previewRequest=(this._previewRequest||0)+1;
    this._importRevision=this.data.revision;
    this.setData({busy:true,errorText:'',notice:'正在逐项识别证券，请稍候…'});
    const preview=[];
    for(const record of records){
      if(!this._alive || !this._visible || request!==this._previewRequest)break;
      try{
        let candidates;
        if(/^(gold-(au9999|xauusd)|(sh|sz|bj)\d{6}|hk\d{5}|us[A-Z][A-Z0-9.]*)$/.test(record.keyword)) {
          const result=await market.resolve(record.keyword);candidates=[result.asset||result];
        }else{
          const result=await market.search(record.keyword);
          const all=result.assets||result.items||[];
          const exact=all.filter(a=>[a.id,a.code].some(v=>String(v).toLowerCase()===record.keyword.toLowerCase()));
          candidates=exact.length?exact:all;
        }
        candidates=[...new Map(candidates.filter(a=>a && a.id).map(a=>[a.id,a])).values()];
        const asset=candidates.length===1?candidates[0]:null;
        preview.push({...record,candidates,assetId:asset?.id||'',name:asset?.name||'',error:candidates.length?'':'未识别，请修改代码或移除此条'});
      }catch(e){preview.push({...record,candidates:[],assetId:'',name:'',error:e.message||'识别失败'});}
    }
    if(this._alive && this._visible && request===this._previewRequest)this.setData({preview,pendingGroupCount:this._importGroupSettings.length,notice:'请确认所有标的。多市场同代码需选择具体市场；重复自选会跳过。已有备注不被覆盖。',busy:false});
  },
  selectCandidate(e){
    const row=Number(e.currentTarget.dataset.row),index=Number(e.currentTarget.dataset.index),preview=this.data.preview.slice();
    const candidate=preview[row]?.candidates[index];if(!candidate)return;
    preview[row]={...preview[row],assetId:candidate.id,name:candidate.name};this.setData({preview,errorText:''});
  },
  removeImportRow(e){this.setData({preview:this.data.preview.filter((_,i)=>i!==Number(e.currentTarget.dataset.row))});},
  async commitImport(){
    if(this.data.busy)return;
    if((!this.data.preview.length && !this.data.pendingGroupCount) || this.data.preview.some(r=>!r.assetId))return this.setData({errorText:'请为每条记录选择明确标的，或移除未识别记录'});
    const map=new Map();
    for(const r of this.data.preview)if(!map.has(r.assetId))map.set(r.assetId,r);
    const entries=[...map.values()].map(r=>({assetId:r.assetId,note:r.note,tags:r.tags,groups:r.groups}));
    const confirmed=new Set(entries.map(e=>e.assetId));
    const groupSettings=(this._importGroupSettings||[]).map(g=>({...g,assetIds:(g.assetIds||[]).filter(id=>confirmed.has(id))}));
    this.setData({busy:true,errorText:''});const request=this._request=(this._request||0)+1;
    try{
      const s=await portfolio.batchAdd(entries.map(e=>e.assetId),this._importRevision,entries,groupSettings);
      if(this.isCurrent(request)){this.apply(s);this.setData({preview:[],pendingGroupCount:0,raw:'',notice:'导入完成，重复标的已跳过；已有备注保留。'});}
    }catch(e){if(this.isCurrent(request))this.setData({errorText:e.message||'导入失败，尚未写入'});}
    finally{if(this.isCurrent(request))this.setData({busy:false});}
  },
  makeExport(e){
    if(!this._state || this.data.offline)return this.setData({errorText:'请联网取得最新自选后再导出'});
    const format=e.currentTarget.dataset.format;
    this.setData({exportText:format==='csv'?transfer.exportCsv(this._state):transfer.exportJson(this._state),exportFormat:format,exportPath:'',errorText:''});
  },
  async copyExport(){
    try{await invoke(wx.setClipboardData,{data:this.data.exportText});if(this._alive)this.setData({notice:'已复制导出内容'});}
    catch(_){if(this._alive)this.setData({errorText:'复制失败，请重试'});}
  },
  async saveExport(){
    try{
      if(!wx.getFileSystemManager || !wx.env?.USER_DATA_PATH)throw Error('当前环境不支持文件导出，可复制导出内容');
      const path=wx.env.USER_DATA_PATH+'/watchlist-'+Date.now()+'.'+this.data.exportFormat;
      const manager=wx.getFileSystemManager();
      await invoke(manager.writeFile.bind(manager),{filePath:path,data:this.data.exportText,encoding:'utf8'});
      if(this._alive)this.setData({exportPath:path,notice:'文件已生成，可点击分享保存到文件或发送给自己'});
    }catch(e){if(this._alive)this.setData({errorText:e.message||'文件生成失败'});}
  },
  async shareExport(){
    try{if(!wx.shareFileMessage)throw Error('此环境不支持分享文件，可复制导出内容');await invoke(wx.shareFileMessage,{filePath:this.data.exportPath});}
    catch(e){if(this._alive && !/cancel/.test(e.errMsg||''))this.setData({errorText:e.message||'文件分享失败'});}
  },
});
