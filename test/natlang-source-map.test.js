import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {mapBoundedTypeScriptSites,compileBoundedTypeScript} from '../src/typescript.js';
class EvalFailure extends Error{constructor(message,events){super(message);this.events=events;}}
test('TS generated-site anchors refer to exact source bytes and remain private',()=>{
  const seen=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,onTrace:(bundle,request,lowering)=>seen.push({bundle,lowering})});
  const output=env.execute({code:'const n: number = self.value; const add = (x: number) => x + n; return `value=${add(2)}`;',
    body:true,scope:{value:3},path:'natlang://test.ts'});
  assert.equal(output.result,'value=5');
  const {bundle,lowering}=seen[0];
  assert.equal(lowering.sourceMap.sourcesContent.includes(lowering.originalText),true);
  assert.equal(lowering.generatedSiteOrigins.length,bundle.sites.length);
  assert(lowering.generatedSiteOrigins.some(x=>x.status==='anchors'));
  assert(lowering.generatedSiteOrigins.every(x=>x.status==='anchors'||x.status==='generated-only'));
  assert(!Object.hasOwn(bundle,'generatedSiteOrigins'));
});
test('mapping refuses forged source text instead of claiming original site provenance',()=>{
  const original='"use strict";function f(x: number){return x+1;}';
  const lower=compileBoundedTypeScript(original);
  assert.throws(()=>mapBoundedTypeScriptSites(lower,[],original+' '),/original source bytes/);
});
