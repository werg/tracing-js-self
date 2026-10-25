import assert from 'node:assert/strict';
import test from 'node:test';
import {createNatlangSelectedEnvironment,selectedCallable,selectedCell} from '../src/natlang-selected.js';
import {encodeWitness,decodeWitness} from '../src/training/format.js';
import {analyzeSemanticProgram} from '../src/training/semantic-program.js';
import {prepareHostRequest} from '../src/host/operations.js';

const returnValue=value=>encodeWitness('return',{value});
const terminal=encodeWitness('end',{kind:'return'});

test('Natlang uses selected execution for real compiled JS and TypeScript expressions',async()=>{
  const selected=[];
  const adapter=prefix=>{
    selected.push({entry:prefix.entry,source:prefix.source});
    assert.equal(prefix.entry,'run');
    const semantic=prefix.committed.filter(x=>x.kind==='semantic');
    if(semantic.length===0)return encodeWitness('compute',{
      expr:{op:'binary',operator:'+',
        left:{op:'literal',value:['num',2]},
        right:{op:'literal',value:['num',3]}},
      result:['num',5]});
    if(semantic.length===1)return returnValue(['num',5]);
    if(semantic.length===2)return terminal;
    throw new Error('Unexpected selected context');
  };
  const env=createNatlangSelectedEnvironment({select:adapter});
  assert.throws(()=>env.execute({code:'2+3',body:false,path:'t.ts',scope:{}}),
    /asynchronous/);
  const result=await env.executeAsync({code:'2 as number + 3',body:false,
    path:'t.ts',scope:{n:1}});
  assert.equal(result.result,5);
  assert(selected.some(x=>x.source.includes('2 + 3')));
  assert(result.events.some(x=>x.operation==='selected.observation'));
  env.close();
  await assert.rejects(env.executeAsync({code:'3',body:false,path:'t.ts',scope:{}}),
    /closed/);
});

test('selected module initializer exports an owned function trampoline with retained calls',async()=>{
  const selections=[];
  const selector=prefix=>{
    const semantic=prefix.committed.filter(x=>x.kind==='semantic');
    selections.push([prefix.entry,semantic.length]);
    if(prefix.entry==='initialize'){
      if(semantic.length===0)return encodeWitness('allocate',{
        name:'o99',kind:'closure',code:'answer',properties:[],captures:[]});
      if(semantic.length===1)return encodeWitness('write',{object:'o0',
        key:'answer',value:['ref','o99'],present:true});
      if(semantic.length===2)return returnValue(['ref','o0']);
      if(semantic.length===3)return terminal;
    }
    if(prefix.entry==='answer'){
      if(semantic.length===0)return returnValue(['num',42]);
      if(semantic.length===1)return terminal;
    }
    throw new Error('Unexpected execution selection '+prefix.entry+' '+semantic.length);
  };
  const env=createNatlangSelectedEnvironment({mode:'retained',select:selector});
  const exports={};const bindings={exports,module:{exports}};
  const compiled='function answer(){return 42;} exports.answer=answer;';
  const result=await env.evaluateModuleAsync(compiled,bindings);
  assert.equal(result,exports);
  assert.equal(typeof exports.answer,'function');
  assert.equal(await exports.answer(),42);
  assert.equal(await exports.answer(),42);
  assert.equal(selections.filter(x=>x[0]==='initialize').length,4);
  assert.equal(selections.filter(x=>x[0]==='answer').length,4);
  const h=env.selectedHarness();
  const invocations=h.timeline.filter(x=>x.kind==='invocation');
  assert.equal(invocations.length,3);
  assert.equal(new Set(invocations.map(x=>x.realmId)).size,1);
  assert.deepEqual(invocations.map(x=>x.entry),['initialize','answer','answer']);
  assert.throws(()=>env.evaluateModule(compiled,bindings),/requires/);
  await assert.rejects(env.evaluateModuleAsync(compiled,bindings),/already initialized/);
  env.close();
});

function nativeRequest(prefix,{operation='natlang.callSync',effect='e1',args,invocation=prefix.invocationId,promise}){
  const sites=analyzeSemanticProgram(prefix.source).sites.filter(site=>site.operation===operation);
  const site=sites.find(site=>prefix.source.slice(site.start,site.end).includes(JSON.stringify(args[0]?.[1])))??sites[0];
  assert(site,'the selected request must have its actual published source callsite');
  const heap=Object.fromEntries(prefix.selectedState.heap.map(([id,node])=>[id,{...node,
    properties:Object.fromEntries([...node.properties].map(([key,value])=>[key,{value}]))}]));
  const payload=prepareHostRequest(heap,operation,args).payload;
  return encodeWitness('request',{effect,operation,invocation,site:{start:site.start,end:site.end},
    arguments:args,payload,...(promise?{promise}:{})});
}
const selectedCount=prefix=>prefix.committed.filter(item=>item.kind==='semantic').length;
const resultValue=prefix=>decodeWitness(prefix.committed.findLast(item=>item.kind==='result').line).fields.result;

test('declared native callable receives the actual selected graph once through the shared broker',async()=>{
  const effects=[];
  const env=createNatlangSelectedEnvironment({select:prefix=>{
    const handle=/host.natlangCallSync\("([^"]+)"/.exec(prefix.source)[1];
    const lines=[
      ()=>encodeWitness('allocate',{name:'o90',kind:'closure',code:'__selected_binding_1',properties:[],captures:[]}),
      ()=>encodeWitness('write',{object:'o1',key:'double',value:['ref','o90'],present:true}),
      ()=>encodeWitness('allocate',{name:'o91',kind:'array',length:1,properties:[{key:'0',value:['num',4]}]}),
      ()=>encodeWitness('call',{child:'native1',callee:'__selected_binding_1',receiver:['undefined'],arguments:[['num',4]]}),
      ()=>nativeRequest(prefix,{invocation:'native1',args:[['str',handle],['undefined'],['ref','o91']]}),
      ()=>encodeWitness('return',{invocation:'native1',value:resultValue(prefix)}),
      ()=>returnValue(resultValue(prefix)),()=>terminal
    ];
    return lines[selectedCount(prefix)]();
  }});
  const output=await env.executeAsync({code:'return __live.double(4);',body:true,path:'native.ts',scope:{},
    live:{double:selectedCallable(n=>{effects.push(n);return n*2;},{kind:'synchronous'})}});
  assert.equal(output.result,8);assert.deepEqual(effects,[4]);
  assert.equal(env.selectedHarness().timeline.filter(item=>item.kind==='dispatch').length,1);env.close();
});

test('a native asynchronous binding calls an owned guest closure through selected reentry',{timeout:3000},async()=>{
  const effects=[],entries=[];
  const env=createNatlangSelectedEnvironment({select:prefix=>{
    entries.push(prefix.entry);
    if(prefix.entry==='callback'){
      const lines=[()=>encodeWitness('compute',{expr:{op:'binary',operator:'+',left:{op:'local',name:'value'},
        right:{op:'literal',value:['num',1]}},result:['num',6],bind:'answer'}),
      ()=>returnValue(['num',6]),()=>terminal];return lines[selectedCount(prefix)]();
    }
    const handle=/host.natlangCall\("([^"]+)"/.exec(prefix.source)[1];
    const lines=[
      ()=>encodeWitness('allocate',{name:'o90',kind:'closure',code:'__selected_binding_1',properties:[],captures:[]}),
      ()=>encodeWitness('write',{object:'o1',key:'withCallback',value:['ref','o90'],present:true}),
      ()=>encodeWitness('allocate',{name:'o91',kind:'closure',code:'callback',properties:[],captures:[]}),
      ()=>encodeWitness('allocate',{name:'o92',kind:'array',length:1,properties:[{key:'0',value:['ref','o91']}]}),
      ()=>encodeWitness('call',{child:'native1',callee:'__selected_binding_1',receiver:['undefined'],arguments:[['ref','o91']]}),
      ()=>nativeRequest(prefix,{operation:'natlang.call',invocation:'native1',promise:'p1',
        args:[['str',handle],['undefined'],['ref','o92']]}),
      ()=>encodeWitness('return',{invocation:'native1',value:['ref','p1']}),
      ()=>encodeWitness('await',{promise:'p1',continuation:'k1',invocation:prefix.invocationId}),
      ()=>encodeWitness('resume',{continuation:'k1',invocation:prefix.invocationId,status:'fulfilled',result:resultValue(prefix)}),
      ()=>returnValue(resultValue(prefix)),()=>terminal
    ];return lines[selectedCount(prefix)]();
  }});
  const output=await env.executeAsync({code:'return await __live.withCallback(function callback(value){return value+1;});',
    body:true,path:'callback.ts',scope:{},live:{withCallback:selectedCallable(async callback=>{
      effects.push('native-enter');const value=await callback(5);effects.push('native-return');return value;
    })}});
  assert.equal(output.result,6);assert.deepEqual(effects,['native-enter','native-return']);
  assert.equal(entries.filter(entry=>entry==='callback').length,3);
  assert.equal(env.selectedHarness().invocations.size,2);env.close();
});

test('live cell publication invokes no getter and only a committed request reads its value',async()=>{
  let reads=0,value=7;
  const env=createNatlangSelectedEnvironment({select:prefix=>{
    const count=selectedCount(prefix);
    assert.equal(reads,count<2?0:1);
    const handle=/host.natlangReadCell\("([^"]+)"/.exec(prefix.source)[1];
    const lines=[
      ()=>encodeWitness('call',{child:'getter1',callee:'__selected_get_1',receiver:['undefined'],arguments:[]}),
      ()=>nativeRequest(prefix,{operation:'natlang.readCell',invocation:'getter1',args:[['str',handle]]}),
      ()=>encodeWitness('return',{invocation:'getter1',value:resultValue(prefix)}),
      ()=>returnValue(resultValue(prefix)),()=>terminal
    ];return lines[count]();
  }});
  const output=await env.executeAsync({code:'return __live.count;',body:true,path:'cell.ts',scope:{},
    live:{count:selectedCell(()=>{reads++;return value;},next=>{value=next;})}});
  assert.equal(output.result,7);assert.equal(reads,1);env.close();
});

test('timeouts and close abort selection without subsequent native dispatch',{timeout:1000},async()=>{
  let release;
  const env=createNatlangSelectedEnvironment({select:()=>new Promise(resolve=>{release=resolve;})});
  await assert.rejects(env.executeAsync({code:'1',body:false,path:'timeout.ts',scope:{},timeoutMs:1}),/timed out/);
  release(returnValue(['num',1]));
  assert.equal(env.selectedHarness().timeline.filter(item=>item.kind==='semantic').length,0);
  env.close();assert.throws(()=>env.fork(),/closed/);
});

test('retained native callbacks run in their source realm after the registering invocation completes',{timeout:3000},async()=>{
  let retained;const callbackRealms=[];
  const env=createNatlangSelectedEnvironment({select:prefix=>{
    const count=selectedCount(prefix);
    if(prefix.entry==='callback'){
      callbackRealms.push(prefix.realmId);
      if(count===0)return returnValue(['num',6]);return terminal;
    }
    const installing=prefix.source.includes('__live.install(');
    const method=installing?'natlangCallSync':'natlangCall';
    const handle=new RegExp('host\\.'+method+'\\("([^\"]+)"').exec(prefix.source)[1];
    const binding='__selected_binding_'+handle.split(':').at(-1);
    const lines=[
      ()=>encodeWitness('allocate',{name:'o90',kind:'closure',code:binding,properties:[],captures:[]}),
      ()=>encodeWitness('write',{object:'o1',key:installing?'install':'fire',value:['ref','o90'],present:true}),
      ...(installing?[()=>encodeWitness('allocate',{name:'o91',kind:'closure',code:'callback',properties:[],captures:[]})]:[]),
      ()=>encodeWitness('allocate',{name:'o92',kind:'array',length:1,
        properties:[{key:'0',value:installing?['ref','o91']:['num',5]}]}),
      ()=>encodeWitness('call',{child:'native1',callee:binding,receiver:['undefined'],
        arguments:[installing?['ref','o91']:['num',5]]}),
      ()=>nativeRequest(prefix,{operation:installing?'natlang.callSync':'natlang.call',invocation:'native1',
        ...(installing?{}:{promise:'p1'}),args:[['str',handle],['undefined'],['ref','o92']]}),
      ()=>encodeWitness('return',{invocation:'native1',value:installing?['undefined']:['ref','p1']}),
      ...(!installing?[
        ()=>encodeWitness('await',{promise:'p1',continuation:'k1',invocation:prefix.invocationId}),
        ()=>encodeWitness('resume',{continuation:'k1',invocation:prefix.invocationId,status:'fulfilled',result:resultValue(prefix)})]:[]),
      ()=>returnValue(installing?['undefined']:resultValue(prefix)),()=>terminal
    ];return lines[count]();
  }});
  await env.executeAsync({code:'__live.install(function callback(value){return value+1;});',
    body:true,path:'install.ts',scope:{},live:{install:selectedCallable(callback=>{retained=callback;},{kind:'synchronous'})}});
  const result=await env.executeAsync({code:'return await __live.fire(5);',body:true,path:'fire.ts',scope:{},
    live:{fire:selectedCallable(async value=>retained(value))}});
  assert.equal(result.result,6);assert.deepEqual(callbackRealms,['realm1','realm1']);
  const invocations=env.selectedHarness().timeline.filter(item=>item.kind==='invocation');
  assert.deepEqual(invocations.map(item=>item.realmId),['realm1','realm2','realm1']);env.close();
  await assert.rejects(retained(5),/closed/,'late native delivery cannot revive a closed selected environment');
});

test('native callback resource inputs use declared envelopes and selected wrapper reentry',{timeout:3000},async()=>{
  class Box{constructor(value){this.value=value;}}
  const surfaces=new WeakMap(),originals=new WeakMap();let reads=0,disposed=0;
  const adaptValue=value=>{
    if(!(value instanceof Box))return value;
    if(!surfaces.has(value)){
      const surface=Object.defineProperty(Object.create(null),'value',{get:()=>{reads++;return value.value;},enumerable:true});
      surfaces.set(value,surface);originals.set(surface,value);
    }return surfaces.get(value);
  };
  const environment=createNatlangSelectedEnvironment({adaptValue,resourceIdentity:value=>originals.get(value)??null,
    resourceCleanup:()=>()=>{disposed++;},select:prefix=>{
      const count=selectedCount(prefix);
      if(prefix.entry==='__selected_callback'){
        const nodes=new Map(prefix.selectedState.heap);
        const read=(id,key)=>new Map(nodes.get(id).properties).get(key);
        const envelope=prefix.committed.find(item=>item.kind==='invocation').inputGraph.roots[0];
        const properties=read(envelope[1],'properties'),property=read(properties[1],'0'),cell=read(property[1],'cell'),handle=read(cell[1],'handle');
        const lines=[
          ()=>encodeWitness('bind',{name:'getterHandle',value:handle}),
          ()=>encodeWitness('allocate',{name:'o1500',kind:'object',properties:[]}),
          ()=>encodeWitness('call',{child:'original1',callee:'useBox',receiver:['undefined'],arguments:[['ref','o1500']]}),
          ()=>encodeWitness('call',{child:'resourceget1',callee:'__selected_dynamicGet',receiver:['ref','o1500'],arguments:[]}),
          ()=>nativeRequest(prefix,{operation:'natlang.readCell',invocation:'resourceget1',args:[handle]}),
          ()=>encodeWitness('return',{invocation:'resourceget1',value:resultValue(prefix)}),
          ()=>encodeWitness('return',{invocation:'original1',value:resultValue(prefix)}),
          ()=>returnValue(resultValue(prefix)),()=>terminal
        ];return lines[count]();
      }
      const handle=/host.natlangCall\("([^"]+)"/.exec(prefix.source)[1];
      const lines=[
        ()=>encodeWitness('allocate',{name:'o90',kind:'closure',code:'useBox',properties:[],captures:[]}),
        ()=>encodeWitness('bind',{name:'callbackTarget',value:['ref','o90']}),
        ()=>encodeWitness('allocate',{name:'o91',kind:'closure',code:'__selected_callback',properties:[],captures:[{binding:'target',cell:'callbackTarget'}]}),
        ()=>encodeWitness('allocate',{name:'o92',kind:'array',length:1,properties:[{key:'0',value:['ref','o91']}]}),
        ()=>encodeWitness('call',{child:'native1',callee:'__selected_binding_1',receiver:['undefined'],arguments:[['ref','o91']]}),
        ()=>nativeRequest(prefix,{operation:'natlang.call',invocation:'native1',promise:'p1',args:[['str',handle],['undefined'],['ref','o92']]}),
        ()=>encodeWitness('return',{invocation:'native1',value:['ref','p1']}),
        ()=>encodeWitness('await',{invocation:prefix.invocationId,promise:'p1',continuation:'k1'}),
        ()=>encodeWitness('resume',{invocation:prefix.invocationId,continuation:'k1',status:'fulfilled',result:resultValue(prefix)}),
        ()=>returnValue(resultValue(prefix)),()=>terminal
      ];return lines[count]();
    }});
  const result=await environment.executeAsync({code:'return await __live.withBox(function useBox(box){return box.value;});',
    body:true,path:'resource.ts',scope:{},live:{withBox:selectedCallable(async callback=>callback(new Box(7)))}});
  assert.equal(result.result,7);assert.equal(reads,1,'only the committed native cell read invokes the getter');
  environment.close();environment.close();assert.equal(disposed,1,'returned native resource ownership closes once');
});

test('exported functions retain one live captured cell and one owned namespace across repeated calls',async()=>{
  const env=createNatlangSelectedEnvironment({mode:'retained',select:prefix=>{
    const count=selectedCount(prefix);
    if(prefix.entry==='initialize'){
      const lines=[
        ()=>encodeWitness('bind',{name:'counterCell',value:['num',0]}),
        ()=>encodeWitness('allocate',{name:'o90',kind:'closure',code:'increment',properties:[],
          captures:[{binding:'count',cell:'counterCell'}]}),
        ()=>encodeWitness('allocate',{name:'o91',kind:'closure',code:'read',properties:[],
          captures:[{binding:'count',cell:'counterCell'}]}),
        ()=>encodeWitness('write',{object:'o0',key:'increment',value:['ref','o90'],present:true}),
        ()=>encodeWitness('write',{object:'o0',key:'read',value:['ref','o91'],present:true}),
        ()=>encodeWitness('write',{object:'o0',key:'current',value:['num',0],present:true}),
        ()=>returnValue(['ref','o0']),()=>terminal
      ];return lines[count]();
    }
    const locals=new Map(prefix.selectedState.locals),current=locals.get('counterCell')[1];
    if(prefix.entry==='increment'){
      if(count===0)return encodeWitness('compute',{expr:{op:'binary',operator:'+',left:{op:'local',name:'count'},
        right:{op:'literal',value:['num',1]}},result:['num',current+1],bind:'count'});
      if(count===1)return encodeWitness('write',{object:'o0',key:'current',value:['num',current],present:true});
      if(count===2)return returnValue(['num',current]);return terminal;
    }
    if(count===0)return returnValue(['num',current]);return terminal;
  }});
  const exports={},module={exports};
  await env.evaluateModuleAsync('let count=0; function increment(){count++;exports.current=count;return count;} '+
    'function read(){return count;} exports.increment=increment;exports.read=read;exports.current=count;', {exports,module});
  assert.equal(exports.increment,exports.increment,'function identity stays stable');
  assert.equal(await exports.increment(),1);assert.equal(exports.current,1);
  assert.equal(await exports.increment(),2);assert.equal(await exports.read(),2);assert.equal(exports.current,2);
  const stale=exports.increment;env.close();await assert.rejects(stale(),/closed/);
});
