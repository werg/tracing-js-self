// Independent V8 execution is a fixed-fixture reference oracle, never
// an execution fallback inside the owned tracer.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createRuntime} from '../src/runtime.js';
import {decode} from '../src/values.js';
import {validateBundle} from '../src/validation.js';
import {replayExact} from '../src/replay.js';

function observed(runtime){
  const entry=Object.values(runtime.state.envs).flatMap(env=>Object.entries(env.bindings))
    .find(([name])=>name==='result');
  assert(entry,'Fixture must expose result binding');
  const tag=entry[1].token.value;
  return decode(tag);
}
const fixtures=[
  `let result=0;try{throw 5;}catch(e){result=e+1;}`,
  `let result=0;try{throw 'x';}catch{result=7;}`,
  `let result=0;try{result=1;}finally{result+=2;}`,
  `let result='';try{try{throw 'A';}catch(e){throw e+'B';}finally{result+='f';}}catch(e){result+=e;}`,
  `let result=0;function f(){try{return 3;}finally{result+=7;}}result+=f();`,
  `let result=0;function f(){try{return 3;}finally{return 4;}}result=f();`,
  `let result='';function f(){try{return 3;}finally{throw 'e';}}try{f();}catch(e){result=e;}`,
  `let result=0;function f(){throw 19;}try{f();}catch(e){result=e;}`,
  `let result=0;try{throw 1;}catch(e){let z=e;result=z;}finally{result*=2;}`,
  `let result=0;let x=0;while(x<5){x+=1;try{if(x===2)continue;if(x===4)break;result+=x;}finally{result+=10;}}`,
  `let result=0;try{let x=0;while(x<3){x+=1;break;}result=4;}finally{result+=5;}`,
  `let result=0;let x=0;while(x<4){x+=1;let y=0;while(y<3){y+=1;try{if(y===2)continue;if(x===3)break;result+=1;}finally{result+=2;}}}`,
  `let result=0;function f(){try{try{return 2;}finally{result+=3;}}finally{result+=5;}}result+=f();`,
  `let result='';try{try{throw 0;}finally{result+='f';}}catch(e){result+=e;}`,
  `let result=0;let e=1;try{throw 3;}catch(e){result=e;}result+=e;`,
  `let result=0;try{throw {x:8};}catch(e){result=e.x;}`,
  `let result=0;try{throw 10n;}catch(e){result=NumberMarker;}`.replace('NumberMarker','e===10n'),
  `let result=0;function f(){try{throw 3;}catch(e){return e+4;}finally{result+=5;}}result+=f();`
];

test('bounded synchronous control completions agree with independent V8 final scalars',()=>{
  for(const source of fixtures){
    const expected=vm.runInNewContext(source+'\nresult;',Object.create(null),{timeout:1000});
    const runtime=createRuntime().start(source);
    assert.equal(runtime.drive().kind,'terminated',source);
    assert.deepEqual(Object.is(observed(runtime),expected),true,
      'Scalar SameValue mismatch: '+source+' (tracer='+String(observed(runtime))+', V8='+String(expected)+')');
    const bundle=JSON.parse(JSON.stringify(runtime.exportRun()));
    assert.equal(validateBundle(bundle).valid,true,source);
    assert.equal(replayExact(bundle).valid,true,source);
  }
});
