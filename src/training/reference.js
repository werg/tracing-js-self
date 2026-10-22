// Independent V8 reference for the admitted, deterministic synchronous profile.
// This is verification ONLY: the reference never supplies guest VM operations.
// Node vm is not a security sandbox for hostile user code. Use trusted generated
// cases and a separate process/container for untrusted corpus submissions.
import vm from 'node:vm';
import {realizeGraph,describeGraph} from './graph.js';

export function referenceOutcome({source,entry,args,initialHeap,timeout=1000}) {
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
  const script=new vm.Script(source+'\n__trainingResult = '+entry+'.apply(undefined,__trainingArgs);',
    {filename:'training-reference.js'});
  try{
    script.runInContext(context,{timeout});
  }catch(error){
    return {kind:'reference.error',name:error?.name??'Error',message:String(error?.message??error)};
  }
  try {
    return {kind:'return',graph:describeGraph([...context.__trainingArgs,context.__trainingResult])};
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
