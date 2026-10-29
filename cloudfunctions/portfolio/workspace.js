const crypto = require('crypto');
const { validId } = require('./securities');
const ACTIONS = ['saveGroup','deleteGroup','batchAdd'];
const SORTS = ['manual','price','changePct','amount'];
function fail(code, hint) { throw Object.assign(Error(hint), { businessCode:code }); }
const groupId = () => 'g-' + crypto.randomBytes(8).toString('hex');
function name(value) {
  if (typeof value !== 'string' || !value.trim() || Array.from(value.trim()).length > 16)
    fail('bad-group','分组名称需为 1–16 字');
  return value.trim();
}
function prepare(event) {
  if (!ACTIONS.includes(event.action)) return null;
  if (!Number.isSafeInteger(event.revision) || event.revision < 0) fail('bad-revision','请刷新后重试');
  const out = { action:event.action, revision:event.revision };
  if (event.action === 'saveGroup') {
    const g = event.group;
    if (!g || (g.id != null && (typeof g.id !== 'string' || !/^g-[a-f0-9]{16}$/.test(g.id))) ||
      !Array.isArray(g.assetIds) || g.assetIds.length > 30 || !g.assetIds.every(validId) ||
      !SORTS.includes(g.sortBy) || !['asc','desc'].includes(g.sortDirection)) fail('bad-group','分组内容或排序格式不正确');
    out.group = { ...(g.id ? {id:g.id} : {}), name:name(g.name), assetIds:[...new Set(g.assetIds)],sortBy:g.sortBy,sortDirection:g.sortDirection };
  }
  if (event.action === 'deleteGroup') {
    if (typeof event.groupId !== 'string' || !/^g-[a-f0-9]{16}$/.test(event.groupId)) fail('bad-group','分组标识无效');
    out.groupId = event.groupId;
  }
  if (event.action === 'batchAdd') {
    if (!Array.isArray(event.assetIds) || (!event.assetIds.length && !event.groupSettings?.length) || event.assetIds.length > 30 || !event.assetIds.every(validId))
      fail('bad-import','一次可导入 1–30 个有效标的');
    out.assetIds = [...new Set(event.assetIds)];
    if(event.groupSettings!=null && (!Array.isArray(event.groupSettings)||event.groupSettings.length>10))fail('bad-import','导入分组格式无效');
    out.groupSettings=(event.groupSettings||[]).map(g=>{
      if(!g||!SORTS.includes(g.sortBy)||!['asc','desc'].includes(g.sortDirection))fail('bad-import','导入分组排序无效');
      if(g.assetIds!=null && (!Array.isArray(g.assetIds)||g.assetIds.length>30||!g.assetIds.every(validId)))fail('bad-import','导入分组成员无效');
      return{name:name(g.name),sortBy:g.sortBy,sortDirection:g.sortDirection,assetIds:[...new Set(g.assetIds||[])]};
    });
    if (event.entries != null && (!Array.isArray(event.entries) || event.entries.length > 30)) fail('bad-import','导入笔记格式不正确');
    out.entries = (event.entries || []).map(e => {
      if (!e || !out.assetIds.includes(e.assetId) || typeof e.note !== 'string' || !Array.isArray(e.tags) ||
        !e.tags.every(t => typeof t === 'string') || !Array.isArray(e.groups) || e.groups.length > 10)
        fail('bad-import','导入记录需包含标的、备注、标签及分组');
      const note=e.note.trim(), tags=[...new Set(e.tags.map(t=>t.trim()).filter(Boolean))];
      if (Array.from(note).length > 120 || tags.length > 3 || tags.some(t=>Array.from(t).length>8)) fail('bad-import','导入备注或标签超出长度限制');
      return {assetId:e.assetId,note,tags,groups:[...new Set(e.groups.map(name))]};
    });
    if (new Set(out.entries.map(e=>e.assetId)).size !== out.entries.length) fail('bad-import','导入记录不能包含重复标的');
  }
  return out;
}
function apply(doc, input, limits, now) {
  if (!input) return false;
  if (input.revision !== doc.revision) fail('revision-conflict','自选已更新，请刷新后重试');
  if (input.action === 'saveGroup') {
    const group = input.group;
    if (group.assetIds.some(id=>!doc.items.includes(id))) fail('not-watched','分组仅可包含已加入自选的标的');
    const index = doc.groups.findIndex(g=>g.id===group.id);
    if (group.id && index<0) fail('unknown-group','分组已不存在，请刷新');
    if (doc.groups.some(g=>g.name===group.name && g.id!==group.id)) fail('duplicate-group','已有同名分组');
    if (index<0 && doc.groups.length>=10) fail('group-limit','最多创建 10 个分组');
    const next={...group,id:group.id || groupId()};
    if (index<0) doc.groups.push(next); else doc.groups[index]=next;
    return true;
  }
  if (input.action === 'deleteGroup') {
    const previous=doc.groups.length;
    doc.groups=doc.groups.filter(g=>g.id!==input.groupId);
    return previous!==doc.groups.length;
  }
  const newIds=input.assetIds.filter(id=>!doc.items.includes(id));
  if (doc.items.length + newIds.length > limits.watchlist) fail('watchlist-limit','导入后超出自选数量上限，请减少条目');
  doc.items.push(...newIds);
  let changed=!!newIds.length;
  for(const settings of input.groupSettings) {
    if(settings.assetIds.some(id=>!doc.items.includes(id)))fail('bad-import','导入分组包含未导入或未自选的标的');
    if(!doc.groups.some(g=>g.name===settings.name)){
      if(doc.groups.length>=10)fail('group-limit','导入后超出 10 个分组');
      doc.groups.push({id:groupId(),...settings,assetIds:[...settings.assetIds]});changed=true;
    }
  }
  for (const entry of input.entries) {
    if (!doc.annotations[entry.assetId] && (entry.note || entry.tags.length)) {
      doc.annotations[entry.assetId]={note:entry.note,tags:entry.tags,updatedAt:now}; changed=true;
    }
    for (const groupName of entry.groups) {
      let group=doc.groups.find(g=>g.name===groupName);
      if (!group) {
        if (doc.groups.length>=10) fail('group-limit','导入后超出 10 个分组，请减少分组');
        const settings=input.groupSettings.find(g=>g.name===groupName);
        group={id:groupId(),name:groupName,assetIds:[],sortBy:settings?.sortBy||'manual',sortDirection:settings?.sortDirection||'asc'}; doc.groups.push(group); changed=true;
      }
      if (!group.assetIds.includes(entry.assetId)) { group.assetIds.push(entry.assetId); changed=true; }
    }
  }
  return changed;
}
module.exports={ACTIONS,SORTS,prepare,apply};
