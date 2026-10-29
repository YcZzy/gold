const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
function pageHarness(file,stubs={}) {
  let page;const stored=new Map(),routes=[];
  const wx={getStorageSync:k=>stored.get(k),setStorageSync:(k,v)=>stored.set(k,v),
    setNavigationBarColor(){},navigateTo:r=>routes.push(r.url),showToast(){},stopPullDownRefresh(){},
    showModal:r=>r.success?.({confirm:true}),...stubs.wx};
  const filename=path.resolve(__dirname,'../..',file);
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Page:p=>page=p,wx,
    require:id=>{const name=id.split('/').pop();if(Object.prototype.hasOwnProperty.call(stubs,name))return stubs[name];
      if(name==='theme')return {getTheme:()=> 'paper',applyChrome(){},chartColors:()=>({})};
      return require(path.resolve(path.dirname(filename),id));},
    setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},Date,console,Promise});
  page.data=structuredClone(page.data);page.setData=(p,callback)=>{Object.assign(page.data,p);callback?.();};
  return{page,wx,stored,routes};
}
module.exports={pageHarness};
