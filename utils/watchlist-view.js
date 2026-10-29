function select(rows,groups=[],options={}) {
  const group=groups.find(g=>g.id===options.groupId);
  const order=group ? group.assetIds : rows.map(r=>r.id);
  const rank=new Map(order.map((id,i)=>[id,i]));
  let result=rows.filter(row=>!group || rank.has(row.id)).filter(row=>
    (!options.market || options.market==='all' || row.market===options.market) &&
    (!options.kind || options.kind==='all' || row.kind===options.kind) &&
    (!options.query || [row.name,row.code,row.note,...(row.tags||[])].join(' ').toLowerCase().includes(options.query.toLowerCase())));
  for (const [input,field,compare] of [['minPrice','price',(a,b)=>a>=b],['maxPrice','price',(a,b)=>a<=b],['minPct','changePct',(a,b)=>a>=b],['maxPct','changePct',(a,b)=>a<=b]]) {
    const value=options[input];
    if (value!=='' && value!=null && Number.isFinite(Number(value))) result=result.filter(r=>r[field]!=null && Number.isFinite(Number(r[field])) && compare(Number(r[field]),Number(value)));
  }
  const by=options.sortBy || (group && group.sortBy) || 'manual';
  const direction=(options.sortDirection || (group && group.sortDirection))==='desc'?-1:1;
  return result.sort((a,b)=>{
    if (['price','changePct','amount'].includes(by)) {
      const x=a[by],y=b[by],nx=x==null || !Number.isFinite(Number(x)),ny=y==null || !Number.isFinite(Number(y));
      if (nx!==ny) return nx?1:-1;
      if (!nx && Number(x)!==Number(y)) return (Number(x)-Number(y))*direction;
    }
    return (rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity);
  });
}
module.exports={select};
