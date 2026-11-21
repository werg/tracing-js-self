import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {gitBlobSha} from '../src/test262-baseline.js';
import {buildTest262Catalog} from '../src/conformance/test262-catalog.js';
import {discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {unresolvedOriginalModuleBindings} from '../src/conformance/test262-module-resolution.js';
import {ownedTest262Profile,executeOfficialTest262Variant} from '../src/conformance/test262-runner.js';
import {executeOfficialTest262Reference} from '../src/conformance/test262-reference.js';

const base=new URL('../fixtures/test262-namespace-reexports/',import.meta.url),
  pin=JSON.parse(readFileSync(new URL('snapshot.lock.json',base),'utf8')),
  modules=Object.fromEntries(Object.keys(pin.files).map(name=>[
    pin.originalDirectory+name,readFileSync(new URL(name,base),'utf8')]));

test('unchanged pinned Test262 namespace reexports resolve to one target module identity',()=>{
  assert.equal(pin.repository,'tc39/test262');
  assert.equal(pin.revision,'d53ebc8b1931d9f1541e43d59650776e4b766248');
  for(const [name,entry]of Object.entries(pin.files)){
    const source=modules[pin.originalDirectory+name];
    assert.equal(gitBlobSha(source),entry.gitBlobSha,name+' must retain original upstream bytes');
    assert.equal(Buffer.byteLength(source),entry.bytes);
  }
  const parsed=new Map(Object.entries(modules).map(([path,source])=>[
    path,parse(source,{ecmaVersion:2026,sourceType:'module'})]));
  assert.deepEqual(unresolvedOriginalModuleBindings(parsed),[]);
});

test('original namespace bodies execute owned while preserving the independent native result',t=>{
  const sources={...modules,...Object.fromEntries(['assert.js','sta.js'].map(name=>[
    'harness/'+name,readFileSync(new URL('../fixtures/test262-harness/'+name,import.meta.url),'utf8')]))},
    snapshot={repository:pin.repository,revision:pin.revision,
      files:Object.fromEntries(Object.entries(sources).map(([path,source])=>[path,gitBlobSha(source)]))},
    profile=ownedTest262Profile(),catalog=buildTest262Catalog({snapshot,sources,profile,
      moduleDependencies:discoverTest262ModuleDependencies(sources)});
  assert.equal(catalog.variants.length,2);
  for(const variant of catalog.variants){
    const options={variant,profile,suiteRevision:pin.revision,sources},
      owned=executeOfficialTest262Variant(options),reference=executeOfficialTest262Reference(options);
    assert.equal(owned.status,'passed',owned.reason);
    assert.equal(owned.executionPerformed,true);
    assert.equal(owned.trace.structurallyValidated,true);
    assert.equal(owned.trace.exactlyReplayed,true);
    assert.equal(owned.claims.admitted,false);
    // Current Node 24 fails these unchanged graphs during resolution. A later
    // native engine may implement the retained specification; preserve either
    // actual result rather than treating our source-only check as a native pass.
    assert(['failed','passed'].includes(reference.status),reference.reason);
    if(reference.status==='failed'){
      assert.equal(reference.phase,'resolution');assert.equal(reference.errorType,'SyntaxError');
    }
    t.diagnostic(JSON.stringify({path:variant.path,controlVariantId:variant.id,
      authority:'ECMA-262 17.0 ParseModule 10.a.ii / ResolveExport',
      sourceOnlyResolution:'passed',owned:owned.status,nativeReference:{status:reference.status,
        phase:reference.phase,errorType:reference.errorType??null,engine:reference.engine},admitted:false}));
  }
});
