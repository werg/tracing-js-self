import test from 'node:test';
import assert from 'node:assert/strict';
import {compileBoundedTypeScript,mapBoundedTypeScriptSites} from '../src/typescript.js';
import {linkEvaluatedModules,executeEvaluatedModules} from '../src/evaluated-modules.js';

test('ordinary JavaScript keeps its exact bytes and explicit identity provenance',()=>{
  const text=`import {add} from './state.js';
const value=await {get then(){return function(resolve){resolve(7);};}};
queueMicrotask(()=>add('q'));
`;
  for(const path of ['main.js','main.mjs','main.cjs']){
    const compiled=compileBoundedTypeScript(text,{path});
    assert.equal(compiled.javascript,text);
    assert.equal(compiled.compiler,'identity-javascript/1');
    assert.deepEqual(compiled.sourceMap.sources,[path]);
    assert.deepEqual(compiled.sourceMap.sourcesContent,[text]);
    // The pinned TS emitter previously repeated this observable statement
    // while reporting no diagnostics. JavaScript bypasses that emitter.
    assert.equal(compiled.javascript.match(/queueMicrotask/g).length,1);
  }
});

test('identity source maps preserve exact columns across lines, CRLF and UTF-16 text',()=>{
  const text='// α😀\r\n\nexport const n=7;\nexport function read(){return n;}\n';
  const lowering=compileBoundedTypeScript(text,{path:'source.mjs'});
  const sites=['α','😀','n=7','7;','return n','n;}'].map((word,index)=>({
    siteId:'s'+index,start:text.indexOf(word),end:text.indexOf(word)+word.length
  }));
  const mapped=mapBoundedTypeScriptSites(lowering,sites,text);
  for(let index=0;index<sites.length;index++){
    assert.equal(mapped[index].status,'anchors');
    for(const [side,offset] of [['originalStart',sites[index].start],['originalEnd',sites[index].end-1]]){
      const before=text.slice(0,offset);
      assert.equal(mapped[index][side].line,before.split('\n').length-1);
      assert.equal(mapped[index][side].column,offset-before.lastIndexOf('\n')-1);
    }
  }
});

test('typed TypeScript retains pinned lowering and executable module provenance',async()=>{
  const source='type Item={value:number};export const n:number=4;'+
    'export function run(item:Item):number{return n+item.value;}';
  const lowering=compileBoundedTypeScript(source,{path:'main.ts'});
  assert.match(lowering.compiler,/^typescript\/5\.9\.3$/);
  assert(!lowering.javascript.includes(':number'));
  assert.deepEqual(lowering.sourceMap.sourcesContent,[source]);
  const request={modules:{'main.ts':source},entryModule:'main.ts',exportName:'run',args:[{value:3}]};
  const linked=linkEvaluatedModules(request);
  assert.equal(linked.metadata.modules[0].transpiler,lowering.compiler);
  const result=await executeEvaluatedModules(request);
  assert.equal(result.result,7);
});
