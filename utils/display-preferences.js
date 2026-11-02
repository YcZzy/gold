// Fixed display defaults shared by existing page renderers. Device overrides retired.
const DEFAULTS=Object.freeze({quiet:false,compact:false,hideAmounts:false,showChange:true,showTime:true,showNotes:true});
function get(){return {...DEFAULTS};}
function colors(base){return base;}
module.exports={get,colors,DEFAULTS};
