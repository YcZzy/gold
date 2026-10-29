'use strict';

function validId(id) {
  return typeof id === 'string' && id.length <= 40 &&
    (/^gold-(?:au9999|xauusd)$/.test(id) || /^(?:sh|sz|bj)\d{6}$/.test(id) ||
      /^hk\d{5}$/.test(id) || /^us[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(id));
}

function metadata(found, id) {
  if (!found || found.id !== id || !validId(id) || !['stock','etf','lof'].includes(found.kind)) return null;
  const market = id.slice(0,2).toUpperCase();
  if (!['SH','SZ','BJ','HK','US'].includes(market) || found.market !== market || found.code !== id.slice(2)) return null;
  if (found.kind === 'lof' && (!((market === 'SH' && /^(501|502)\d{3}$/.test(found.code)) ||
      (market === 'SZ' && /^16\d{4}$/.test(found.code))) || found.unit !== '元/份' ||
      found.precision < 3 || found.typeVerified !== 'tencent' || found.identityVerified !== 'tencent')) return null;
  if (!['CNY','HKD','USD'].includes(found.currency) ||
      (['SH','SZ','BJ'].includes(market) && found.currency !== 'CNY') ||
      (market === 'US' && found.currency !== 'USD')) return null;
  if (!['name','code','unit','secid','quoteCode'].every(k => typeof found[k] === 'string' && found[k] && found[k].length <= 128)) return null;
  if (!Number.isInteger(found.precision) || found.precision < 0 || found.precision > 6) return null;
  const timezone = market === 'US' ? 'America/New_York' : market === 'HK' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  if ((found.timezone != null && found.timezone !== timezone) ||
      (['HK','US','BJ'].includes(market) && found.timezone !== timezone)) return null;
  if (found.supportsClose != null && typeof found.supportsClose !== 'boolean') return null;
  if (found.providers != null && (typeof found.providers !== 'object' || Array.isArray(found.providers) ||
      !Object.entries(found.providers).every(([key,value]) => /^[a-zA-Z]+$/.test(key) && typeof value === 'string' &&
        ((key === 'eastmoneyVerified' && value === 'metadata+raw-chart') || /^[a-zA-Z0-9_.:-]{1,64}$/.test(value))))) return null;
  const keys = ['id','name','code','market','kind','currency','unit','secid','quoteCode','precision','timezone','exchange','providers','supportsClose','catalogUpdatedAt'];
  return Object.fromEntries(keys.filter(k => found[k] !== undefined).map(k=>[k,found[k]]));
}

module.exports = { validId, metadata };
