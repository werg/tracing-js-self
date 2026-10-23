import test from 'node:test';
import assert from 'node:assert/strict';
import {createBoundedNatlangEnvironment} from '../src/natlang.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

class EvalFailure extends Error {
  constructor(message,events,debug={}) {
    super(message);
    this.name='EvalFailure';
    this.events=events;this.debug=debug;
  }
}
const req=(code,{body=false,scope={x:4},path='natlang://fixture',...rest}={})=>({
  code,body,scope,path,...rest
});
function setup(options={}){
  const traces=[];
  const env=createBoundedNatlangEnvironment({EvalFailure,
    onTrace:(bundle,request)=>{traces.push({bundle,request});},...options});
  return {env,traces};
}
test('natlang-shaped bounded scalar expression returns an independently replayable trace',()=>{
  const {env,traces}=setup();
  const result=env.execute(req('self.x+3'));
  assert.equal(result.result,7);
  assert.deepEqual(result.logs,[]);
  assert.equal(result.events[0].operation,'typescript.eval');
  assert.equal(result.events[0].status,'completed');
  assert.equal(result.events[0].profile,'training-js/1');
  assert.equal(traces.length,1);
  assert.equal(traces[0].bundle.manifest.profile,'training-js/1');
  assert.equal(traces[0].bundle.sources[0].url,'natlang://fixture');
  assert.equal(validateBundle(traces[0].bundle).valid,true);
  assert.equal(replayExact(traces[0].bundle).valid,true);
});
test('natlang body and portable nested scope execute through owned guest code',()=>{
  const {env,traces}=setup();
  const result=env.execute(req('let x=self.values[0]+self.values[1]; return x*2;',{
    body:true,scope:{values:[2,3]}
  }));
  assert.equal(result.result,10);
  assert.equal(traces.length,1);
});
test('object result is materialized from owned heap without returning guest handles',()=>{
  const {env}=setup();
  const result=env.execute(req('({answer:self.x,parts:[1,2]})'));
  assert.deepEqual(result.result,{answer:4,parts:[1,2]});
});
test('natlang executeAsync fulfills for supported synchronous guest code',async()=>{
  const {env,traces}=setup();
  const result=await env.executeAsync(req('self.x+1'));
  assert.equal(result.result,5);
  assert.equal(traces.length,1);
});
test('TypeScript annotations and assertions lower to replayed owned JS with a source map',()=>{
  const origins=[];
  const {env,traces}=setup({onTrace:(bundle,request,lowering)=>{
    traces.push({bundle,request});origins.push(lowering);
  }});
  const response=env.execute(req(
    'const y: number = self.x as number; return y * 2;', {body:true}));
  assert.equal(response.result,8);
  assert.equal(response.events[0].transpiler,'typescript/5.9.3');
  assert.equal(traces.length,1);
  assert.equal(validateBundle(traces[0].bundle).valid,true);
  assert.equal(replayExact(traces[0].bundle).valid,true);
  assert.equal(origins[0].sourceMap.version,3);
  assert(origins[0].originalText.includes('y: number'));
  assert(!origins[0].javascript.includes('y: number'));
});
test('natlang EvalFailure identity is retained for unsupported TS-emitted JavaScript',()=>{
  const {env,traces}=setup();
  assert.throws(()=>env.execute(req(
    'class C { x: number = 4; } return new C().x;',
    {body:true})),e=>e instanceof EvalFailure && e.events[0].status==='failed');
  assert.throws(()=>env.execute(req('const y: number = ;',{body:true})),EvalFailure);
  assert.equal(traces.length,0);
});
test('live functions/capture cells cannot silently execute or serialize',()=>{
  const {env,traces}=setup();
  assert.throws(()=>env.execute(req('self.x',{live:{f(){return 1;}}})),
    e=>e instanceof EvalFailure&&/primitive|Live natlang bindings/.test(e.message));
  assert.equal(traces.length,0);
});
test('fresh module seam and native timeouts fail closed',()=>{
  const {env}=setup();
  assert.throws(()=>env.evaluateModule('module.exports=2',{}),e=>e instanceof EvalFailure &&
    e.events[0].status==='unsupported');
  assert.throws(()=>env.execute(req('1',{timeoutMs:100})),EvalFailure);
  assert.equal(createBoundedNatlangEnvironment({EvalFailure,mode:'retained'}).mode,'retained');
});
test('close and fork preserve independent environment lifecycle',()=>{
  const {env}=setup();
  const other=env.fork();
  env.close();
  assert.throws(()=>env.execute(req('1')),EvalFailure);
  assert.equal(other.execute(req('2')).result,2);
  other.close();
});
test('step budget fails closed and never publishes a training trace',()=>{
  const {env,traces}=setup({maxSteps:30});
  assert.throws(()=>env.execute(req('while (true) {}',{body:true})),EvalFailure);
  assert.equal(traces.length,0);
});
test('source imports reject unsafe prototype/host identities, without fallback',()=>{
  const {env,traces}=setup();
  assert.throws(()=>env.execute(req('self.x',{scope:{x:new Date(0)}})),EvalFailure);
  assert.equal(traces.length,0);
});
