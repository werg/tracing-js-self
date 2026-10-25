// Selected semantic Natlang evaluator. Guest JS is NEVER run with eval,
// Function, vm, or a native/hybrid fallback. A real Megatoken selector supplies
// each semantic record and the shared broker supplies external observations.
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {SelectedExecutionHarness} from './training/harness-v4.js';
import {SelectedModelDriver} from './training/model-driver.js';

function demand(condition,message){if(!condition)throw new TypeError(message);}
const sourceId=text=>'p'+createHash('sha256').update(text).digest('hex').slice(0,24);
function primitive(value){
  switch(value[0]){
    case 'undefined':return undefined;
    case 'null':return null;
    case 'str':case 'bool':return value[1];
    case 'num':return value[1]==='NaN'?NaN:
      value[1]==='-0'?-0:value[1]==='+Infinity'?Infinity:
      value[1]==='-Infinity'?-Infinity:value[1];
    case 'bigint':return BigInt(value[1]);
    default:throw new Error('Unknown canonical selected guest scalar');
  }
}

/** Create one asynchronous selected evaluator, suitable for Natlang's opt-in
 * fresh and retained factories. The optional transpile callback MUST perform
 * source-to-source compilation only, not execute guest code.
 */
export function createNatlangSelectedEnvironment({mode='fresh',select,services={},
    transpile=source=>ts.transpileModule(source,{compilerOptions:{
      target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,
      isolatedModules:true,removeComments:false}}).outputText,
    capabilities=null,maxSelections=4096,
    sessionId='natlang1',onClose=()=>{}}={}){
  demand(mode==='fresh'||mode==='retained','Natlang environment needs an explicit mode');
  demand(typeof select==='function','A Megatoken selected-model adapter is required');
  demand(typeof transpile==='function','Compilation must be an explicit pure transform');
  const harness=new SelectedExecutionHarness({sessionId,services,maxGenerated:maxSelections});
  const driver=new SelectedModelDriver({select,harness,maxSelections});
  const grants=capabilities??Object.keys(services);
  demand(Array.isArray(grants),'Selected capability grants must be explicit');
  const moduleRealms=new WeakMap();
  let nextRealm=0,nextInvocation=0,closed=false;
  const check=()=>{if(closed)throw new Error('Selected Natlang environment is closed');};
  const run=async({code,entry,args=[],path='<natlang>',realmId=null,
      realmPolicy='fresh',selectedEntry=null})=>{
    check();
    demand(typeof code==='string'&&code.length>0,'Natlang source must be exact JS text');
    const id=sourceId(code);
    const realm=realmId??'realm'+(++nextRealm);
    const invocationId='natlang'+(++nextInvocation);
    const result=await driver.run({programId:id,source:code,entry,
      capabilities:grants,invocationId,trackId:'worker:'+realm,
      realmId:realm,realmPolicy,triggerId:'natlang:'+invocationId,
      args,selectedEntry});
    if(result.completion.kind==='throw')
      throw new Error('Selected Natlang execution threw: '+String(primitive(result.completion.value)));
    const heap=new Map(result.selectedState.heap);
    const seen=new Map();
    const realize=token=>{
      if(token[0]!=='ref')return primitive(token);
      const identity=token[1];
      if(seen.has(identity))return seen.get(identity);
      const data=heap.get(identity);
      if(!data)throw new Error('Selected Natlang result references unknown guest identity');
      if(data.kind==='closure'){
        demand(typeof data.code==='string','Guest closure is missing its source entry');
        const closure=async(...args)=>{
          const child=await run({code,entry,args,path,realmId:realm,
            realmPolicy:'retained',selectedEntry:data.code});
          return child.value;
        };
        seen.set(identity,closure);
        return closure;
      }
      if(!['object','array'].includes(data.kind))
        throw new Error('Behavioral selected guest identity needs a declared native adapter');
      const output=data.kind==='array'?
        new Array(primitive(data.properties.get('length'))) :
        data.prototype===null?Object.create(null):{};
      seen.set(identity,output);
      for(const [key,value] of data.properties){
        if(data.kind==='array'&&key==='length')continue;
        Object.defineProperty(output,key,{value:realize(value),
          writable:true,configurable:true,enumerable:true});
      }
      return output;
    };
    return {value:realize(result.completion.value),
      observations:harness.timeline.filter(item=>item.invocationId===invocationId&&
        item.mode==='observed'),
      trace:result.rendered,invocationId};
  };
  return {
    authority:'selected-semantic/4',mode,
    scopeCapabilities:{allowModules:true,allowNetwork:false},
    execute(){throw new Error('Selected semantic evaluation is asynchronous; use executeAsync');},
    async executeAsync(request){
      check();
      demand(request&&typeof request.code==='string'&&typeof request.path==='string',
        'Natlang selected entry needs exact code and source path');
      const translated=transpile(request.code,{path:request.path,body:request.body});
      demand(typeof translated==='string','Selected source compiler returned nontext');
      const code=request.body?
        'function run(self){\n'+translated+'\n}':
        'function run(self){return ('+translated+');}';
      const response=await run({code,entry:'run',args:[request.scope],
        path:request.path});
      return {result:response.value,
        events:response.observations.map(item=>({operation:'selected.observation',
          kind:item.kind,invocationId:response.invocationId,sequence:item.sequence})),
        logs:[]};
    },
    evaluateModule(){
      throw new Error('Selected module initialization requires evaluateModuleAsync');
    },
    async evaluateModuleAsync(compiled,bindings){
      check();
      demand(typeof compiled==='string'&&bindings&&
        typeof bindings==='object'&&bindings.module,'Natlang module requires compiled source/bindings');
      const previous=moduleRealms.get(bindings.module);
      if(previous)throw new Error('Module was already initialized in this selected realm');
      const exportsValue={};
      const moduleValue={exports:exportsValue};
      // Exact compiled CommonJS bytes are the observed source. The model
      // selects module initialization semantics and may return function
      // closures; later export calls use new retained invocations.
      const code='function initialize(exports,module){\n'+compiled+
        '\nreturn module.exports;\n}';
      const realmId='module'+(++nextRealm);
      const response=await run({code,entry:'initialize',
        args:[exportsValue,moduleValue],realmId,realmPolicy:'retained',
        path:'<natlang-module>'});
      demand(response.value&&typeof response.value==='object',
        'Selected module initialization must return an owned export object');
      Object.assign(bindings.exports,response.value);
      bindings.module.exports=bindings.exports;
      moduleRealms.set(bindings.module,{realmId,sourceId:sourceId(code)});
      return bindings.exports;
    },
    fork(){
      return createNatlangSelectedEnvironment({mode:'fresh',select,services,
        transpile,capabilities:grants,maxSelections,
        sessionId:sessionId+'f'+(++nextRealm),onClose});
    },
    close(){if(!closed){closed=true;onClose();}},
    selectedHarness(){return harness;},
    selectedDriver(){return driver;}
  };
}
