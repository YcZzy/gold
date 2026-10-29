'use strict';
const { calendars } = require('./market-calendar-data.json');
const formatters = new Map();
function timezone(asset) {
  return asset.market === 'US' ? 'America/New_York' : asset.market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
}
function parts(epoch, zone) {
  if (!formatters.has(zone)) formatters.set(zone,new Intl.DateTimeFormat('en-GB',{
    timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  }));
  const p=Object.fromEntries(formatters.get(zone).formatToParts(new Date(epoch)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  const date=`${p.year}-${p.month}-${p.day}`;
  return {date,minutes:Number(p.hour)*60+Number(p.minute),seconds:Number(p.second),weekday:new Date(date+'T00:00:00Z').getUTCDay()};
}
function localEpoch(date, minutes, zone) {
  const desired=Date.parse(date+'T00:00:00Z')+minutes*60000;
  let epoch=desired;
  for(let i=0;i<4;i++) {
    const p=parts(epoch,zone);
    const shown=Date.parse(p.date+'T00:00:00Z')+p.minutes*60000+p.seconds*1000;
    const difference=desired-shown;
    if(!difference)return epoch;
    epoch+=difference;
  }
  throw Error('无法转换交易时区');
}
function session(asset, epoch) {
  const zone=timezone(asset), p=parts(epoch,zone);
  const region=asset.market==='US'?'US':asset.market==='HK'?'HK':['SH','SZ','BJ'].includes(asset.market)?'CN':null;
  const year=calendars[region]?.[p.date.slice(0,4)];
  const result={date:p.date,timezone:zone,known:!!year,phase:'unknown',segment:null,closeTime:null,minutes:p.minutes};
  if(!year)return result;
  const day=p.date.slice(5);
  if([0,6].includes(p.weekday)||year.closed.includes(day))return {...result,phase:'closed'};
  const close=year.earlyClose[day]||(region==='US'?'16:00':region==='HK'?'16:10':'15:00');
  const [h,m]=close.split(':').map(Number),end=h*60+m;
  result.closeTime=localEpoch(p.date,end,zone);
  const minute=p.minutes;
  result.phase='closed';
  if(region==='US') {
    if(minute>=570&&minute<end){result.phase='regular';result.segment='day';}
  } else if(region==='HK') {
    const auction=year.earlyClose[day]?720:960;
    if(minute>=570&&minute<720){result.phase='regular';result.segment='morning';}
    else if(!year.earlyClose[day]&&minute>=780&&minute<960){result.phase='regular';result.segment='afternoon';}
    else if(minute>=auction&&minute<end)result.phase='auction';
    else if(!year.earlyClose[day]&&minute>=720&&minute<780)result.phase='break';
  } else {
    if(minute>=570&&minute<690){result.phase='regular';result.segment='morning';}
    else if(minute>=780&&minute<900){result.phase='regular';result.segment='afternoon';}
    else if(minute>=690&&minute<780)result.phase='break';
  }
  return result;
}

module.exports={session,parts,timezone,localEpoch};
