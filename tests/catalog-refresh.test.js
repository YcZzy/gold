const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
test('catalog refresh retries one transport interruption without bypassing certificate or HTTP errors',()=>{
  const code=`
import importlib.util, urllib.error, ssl
from types import SimpleNamespace
spec=importlib.util.spec_from_file_location('catalog','scripts/update-market-catalog.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert callable(getattr(module,'read_public',None))
class Opener:
    def __init__(self,error):self.error=error;self.calls=0
    def open(self,request,timeout):
        self.calls+=1
        assert request.full_url.startswith('https:')
        if self.calls==1:raise self.error
        return SimpleNamespace(read=lambda:b'complete-response')
opener=Opener(urllib.error.URLError('TLS EOF'))
assert module.read_public(opener,'https://example.test/catalog','https://example.test/')==b'complete-response'
assert opener.calls==2
for error in [urllib.error.HTTPError('https://example.test/',403,'forbidden',None,None),urllib.error.URLError(ssl.SSLCertVerificationError('invalid certificate'))]:
    opener=Opener(error)
    try:module.read_public(opener,'https://example.test/catalog','https://example.test/')
    except urllib.error.URLError:pass
    else:raise AssertionError('unsafe retry')
    assert opener.calls==1
`;
  const r=spawnSync('python3',['-B','-c',code],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
