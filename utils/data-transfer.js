const SCHEMA='gold-watchlist';
function csvRows(text) {
  const rows=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i];
    if(c==='"') { if(quoted && text[i+1]==='"'){cell+='"';i++;} else quoted=!quoted; }
    else if(!quoted && (c===',' || c==='\n' || c==='\r')) {
      row.push(cell);cell='';
      if(c!==',') { if(row.some(s=>s.trim()))rows.push(row); row=[]; if(c==='\r'&&text[i+1]==='\n')i++; }
    } else cell+=c;
  }
  if(quoted)throw Error('CSV 引号未闭合');
  row.push(cell);if(row.some(s=>s.trim()))rows.push(row);return rows;
}
function item(raw) {
  const keyword=String(raw.id || raw.assetId || raw.code || raw.keyword || '').trim();
  if(!keyword || keyword.length>40)throw Error('证券标识为空或过长');
  const note=raw.note==null?'':raw.note;
  const tags=raw.tags==null?[]:raw.tags,groups=raw.groups==null?[]:raw.groups;
  if(typeof note!=='string' || !Array.isArray(tags) || !Array.isArray(groups) || !tags.every(x=>typeof x==='string') || !groups.every(x=>typeof x==='string'))throw Error('备注、标签或分组格式无效');
  if(Array.from(note).length>120 || tags.length>3 || tags.some(t=>Array.from(t).length>8) || groups.length>10 || groups.some(g=>!g.trim() || Array.from(g).length>16))throw Error('备注、标签或分组超出长度限制');
  return {keyword,note,tags,groups};
}
function parse(input) {
  if(typeof input!=='string' || input.length>262144)throw Error('文件大小不能超过 256 KB');
  const text=input.replace(/^\uFEFF/,'').trim();if(!text)throw Error('请粘贴需要导入的内容');
  let rows;
  let groupSettings=[];
  if(text[0]==='{') {
    let data;try{data=JSON.parse(text);}catch(_){throw Error('JSON 格式无效');}
    if(data.schema!==SCHEMA || data.version!==1 || !Array.isArray(data.items))throw Error('不支持的备份格式或版本');
    rows=data.items.map(item);
    if(data.groups!=null){
      if(!Array.isArray(data.groups)||data.groups.length>10)throw Error('备份分组格式无效');
      groupSettings=data.groups.map(g=>{
        if(!g || typeof g.name!=='string'||!g.name.trim()||Array.from(g.name).length>16||!['manual','price','changePct','amount'].includes(g.sortBy)||!['asc','desc'].includes(g.sortDirection))throw Error('备份分组排序格式无效');
        if(g.assetIds!=null && (!Array.isArray(g.assetIds)||g.assetIds.length>30||!g.assetIds.every(id=>typeof id==='string'&&id.length<=40)))throw Error('备份分组成员格式无效');
        return{name:g.name.trim(),sortBy:g.sortBy,sortDirection:g.sortDirection,...(g.assetIds ? {assetIds:g.assetIds}: {})};
      });
    }
  } else if(/^(?:id|assetId|code|代码)\s*,/i.test(text)) {
    const csv=csvRows(text),header=csv.shift().map(x=>x.trim());
    rows=csv.map(cells=>item(Object.fromEntries(header.map((h,i)=>[h==='代码'?'code':h,['tags','groups'].includes(h)?listCell(cells[i]||''):cells[i]||'']))));
  } else rows=text.split(/[,，;；\s]+/).filter(Boolean).map(keyword=>item({keyword}));
  if((!rows.length && !groupSettings.length) || rows.length>30)throw Error('每次请导入 1–30 个标的，或包含分组的备份');
  if(groupSettings.length)rows.groupSettings=groupSettings;
  return rows;
}
function records(state) {
  return (state.items||[]).map(a=>({id:a.id,name:a.name,note:state.annotations?.[a.id]?.note||'',tags:state.annotations?.[a.id]?.tags||[],
    groups:(state.groups||[]).filter(g=>g.assetIds.includes(a.id)).map(g=>g.name)}));
}
function exportJson(state) {return JSON.stringify({schema:SCHEMA,version:1,items:records(state),groups:(state.groups||[]).map(g=>({name:g.name,assetIds:g.assetIds,sortBy:g.sortBy||'manual',sortDirection:g.sortDirection||'asc'}))},null,2);}
function safeCell(value) {
  let text=String(value);if(/^\s*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replace(/"/g,'""')+'"';
}
function listCell(text){if(text.trim().startsWith('[')){try{return JSON.parse(text);}catch(_){throw Error('CSV 标签或分组数组格式无效');}}return text.split('|').filter(Boolean);}
function exportCsv(state) {return '\uFEFFid,name,note,tags,groups\n'+records(state).map(r=>[r.id,r.name,r.note,JSON.stringify(r.tags),JSON.stringify(r.groups)].map(safeCell).join(',')).join('\n');}
module.exports={parse,exportJson,exportCsv,SCHEMA};
