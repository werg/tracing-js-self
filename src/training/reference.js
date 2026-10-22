// Independent V8 reference for the admitted, deterministic synchronous profile.
// This is verification ONLY: the reference never supplies guest VM operations.
// Node vm is not a security sandbox for hostile user code. Use trusted generated
// cases and a separate process/container for untrusted corpus submissions.
import vm from 'node:vm';
import {realizeGraph,describeGraph} from './graph.js';

export function referenceOutcome({source,entry,args,initialHeap,timeout=1000}) {
  if(!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(entry))
    throw new TypeError('Invalid entry identifier');
  const context=vm.createContext(Object.assign(Object.create(null),{
    __trainingArgs:realizeGraph(initialHeap,args),__trainingResult:undefined
  }),{codeGeneration:{strings:false,wasm:false}});
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
