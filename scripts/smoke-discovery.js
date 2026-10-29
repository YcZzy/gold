#!/usr/bin/env node
'use strict';
// Read-only provider smoke. Uses production action routing and an in-memory store only.
// Never initializes wx-server-sdk or writes a user database. Run once, not as a polling job.
const fs=require('node:fs');const path=require('node:path');
const market=require('../cloudfunctions/marketData');
const output=process.argv[2] || path.join(__dirname,'../docs/discovery-smoke-2026-10-29.json');
const snapshots=new Map(),requests=[];let count=0;
const request=async(url,timeout)=>{
 if(++count>24)throw Error('Smoke request budget exceeded');
 const started=Date.now();try{const result=await market.request(url,Math.min(timeout||5000,6000));requests.push({url,status:'ok',durationMs:Date.now()-started});return result;}
 catch(error){requests.push({url,status:'failed',hint:error.message,durationMs:Date.now()-started});throw error;}
};
const service=market.createService({request,store:{get:async(c,k)=>snapshots.get(c+':'+k),set:async(c,k,v)=>snapshots.set(c+':'+k,v),search:async()=>[]}});
const checks=[
 {mode:'indices'}, {mode:'sectors',type:'industry'}, {mode:'sectors',type:'concept'},
 {mode:'members',sectorId:'sina:industry:new_fjzz'}, {mode:'members',sectorId:'sina:concept:gn_hwqc'},
 {mode:'ranking',sort:'gainers'}, {mode:'ranking',sort:'losers'}, {mode:'ranking',sort:'amount'},
 {mode:'flowRanking'}, {mode:'flow',assetId:'sh600519'}, {mode:'orderbook',assetId:'sh600519'},
];
(async()=>{
 const report={startedAt:new Date().toISOString(),method:'production createService, in-memory store; public sources only; no deployment or user database',checks:[],requests};
 for(const params of checks){
  const result=await service.handle({action:'discovery',...params});let valid=result.ok===true;
  if(valid && ['indices','sectors','members','ranking','flowRanking'].includes(params.mode))valid=Array.isArray(result.items) && result.items.length>0;
  if(valid && params.mode==='indices')valid=result.items.every(r=>r.id.startsWith('index:') && r.price>0 && r.sourceTime>0);
  if(valid && params.mode==='flow')valid=typeof result.flow?.main==='number' && result.sourceTime>0;
  if(valid && params.mode==='orderbook')valid=result.bids?.length===5 && result.asks?.length===5 && result.volumeUnit==='share';
  report.checks.push({params,ok:valid,hint:result.hint||null,source:result.source||null,sourceTime:result.sourceTime??null,fetchedAt:result.fetchedAt??null,
   count:result.items?.length??null,total:result.total??null,stale:result.stale??null,scope:result.scope||null,
   sample:result.items?.slice(0,2) || (result.flow?{assetId:result.assetId,flow:result.flow}:result.bids?{bids:result.bids,asks:result.asks}:null)});
  await new Promise(resolve=>setTimeout(resolve,800));
 }
 report.finishedAt=new Date().toISOString();report.passed=report.checks.filter(c=>c.ok).length;report.total=report.checks.length;
 fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({output,passed:report.passed,total:report.total,requests:requests.length}));
 if(report.passed!==report.total)process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;});
