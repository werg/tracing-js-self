// Independent V8 reference for the admitted, deterministic synchronous profile.
// This is verification ONLY: the reference never supplies guest VM operations.
// Node vm is not a security sandbox for hostile user code. Use trusted generated
// cases and a separate process/container for untrusted corpus submissions.
import vm from 'node:vm';
import {realizeGraph,describeGraph} from './graph.js';

export function referenceOutcome({source,entry,args,initialHeap,timeout=1000,observeOperations=false,observeBranches=false,randomSeed=null}) {
  if(!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(entry))
    throw new TypeError('Invalid entry identifier');

  // Keep the graph in the reference realm. Only serialized primitive tags cross
  // from the host: a host-realm array can expose its Function constructor.
  const context=vm.createContext(Object.create(null),
    {codeGeneration:{strings:false,wasm:false}});
  const buildArgs=vm.runInContext(`(function(description) {
    const {heap,roots}=JSON.parse(description);
    const seen=new Map();
    function scalar(value) {
      switch(value[0]) {
        case 'undefined': return undefined;
        case 'null': return null;
        case 'bool': case 'str': return value[1];
        case 'bigint': return BigInt(value[1]);
        case 'num':
          if(value[1]==='-0') return -0;
          if(value[1]==='NaN') return NaN;
          if(value[1]==='+Infinity') return Infinity;
          if(value[1]==='-Infinity') return -Infinity;
          return value[1];
        default: throw new TypeError('Unsupported reference scalar');
      }
    }
    function visit(value) {
      if(value[0]!=='ref') return scalar(value);
      const id=value[1];
      if(seen.has(id)) return seen.get(id);
      const entity=heap[id];
      if(!entity || (entity.kind!=='array' && entity.kind!=='object'))
        throw new TypeError('Unsupported reference graph identity');
      const result=entity.kind==='array'?[]:{};
      seen.set(id,result);
      if(entity.kind==='array') result.length=scalar(entity.properties.length.value);
      for(const [key,record] of Object.entries(entity.properties)) {
        if(entity.kind==='array' && key==='length') continue;
        Object.defineProperty(result,key,{value:visit(record.value),writable:true,
          configurable:true,enumerable:true});
      }
      return result;
    }
    return roots.map(visit);
  })`,context,{timeout});
  context.__trainingArgs=buildArgs(JSON.stringify({heap:initialHeap,roots:args}));
  context.__trainingResult=undefined;
  if(randomSeed!==null){
    if(!Number.isInteger(randomSeed)||randomSeed<0||randomSeed>0xffffffff)
      throw new TypeError('Untrusted reference random fixture seed');
    context.__trainingRandomSeed=randomSeed;
    vm.runInContext(`(function(){let x=__trainingRandomSeed>>>0;
      Math.random=function(){x=(Math.imul(x,1664525)+1013904223)>>>0;return x/4294967296;};
    })()`,context,{timeout});
  }
  if(observeOperations||observeBranches)vm.runInContext(`globalThis.__tracingOperations=[];
    globalThis.__tracingDecisions=[];
    globalThis.__tracingBranch=(site,value)=>{
      globalThis.__tracingDecisions.push({site,decision:['bool',!Boolean(value)]});
      return value;
    };
    globalThis.__tracingLogical=(site,operator,value)=>{
      const skip=operator==='&&'?!Boolean(value):
        operator==='||'?Boolean(value):value!==null&&value!==undefined;
      globalThis.__tracingDecisions.push({site,decision:['bool',skip]});
      return value;
    };
    globalThis.__tracingCapture=(site,value)=>{
      let tagged;
      if(value===null)tagged=['null'];
      else switch(typeof value){
        case 'undefined':tagged=['undefined'];break;
        case 'boolean':tagged=['bool',value];break;
        case 'string':tagged=['str',value];break;
        case 'bigint':tagged=['bigint',value.toString()];break;
        case 'number':tagged=['num',Object.is(value,-0)?'-0':
          Number.isNaN(value)?'NaN':value===Infinity?'+Infinity':
          value===-Infinity?'-Infinity':value];break;
        default:tagged=['unverified',typeof value];
      }
      if(globalThis.__tracingOperations.length>=10000)
        throw new RangeError('Reference operation observation limit');
      globalThis.__tracingOperations.push({site,value:tagged});
      return value;
    };`,context,{timeout});
  const script=new vm.Script(source+'\n__trainingResult = '+entry+'.apply(undefined,__trainingArgs);',
    {filename:'training-reference.js'});
  try{
    script.runInContext(context,{timeout});
  }catch(error){
    return {kind:'reference.error',name:error?.name??'Error',message:String(error?.message??error)};
  }
  try {
    const graph=describeGraph([...context.__trainingArgs,context.__trainingResult]);
    if(!observeOperations&&!observeBranches)return {kind:'return',graph};
    const json=vm.runInContext('JSON.stringify({operations:globalThis.__tracingOperations,decisions:globalThis.__tracingDecisions})',context,{timeout});
    const observations=JSON.parse(json);
    return {kind:'return',graph,
      ...(observeOperations?{operations:observations.operations}:{}),
      ...(observeBranches?{decisions:observations.decisions}:{})};
  } catch(error) {
    return {kind:'reference.unsupported',message:String(error.message)};
  }
}
export function ownedOutcome(runtime) {
  const spec=runtime.entrySpec;
  const completion=runtime.state.control.a0.completion;
  if(!spec || !completion)return {kind:'pending'};
  if(completion.kind!=='return')return {kind:completion.kind};
  return {kind:'return',graph:describeGraph(realizeGraph(runtime.state.heap,
    [...spec.arguments,completion.value]))};
}
