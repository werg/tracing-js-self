// Independent structural authority for entry into separately parsed scripts.
// This module never imports the compiler or invokes the evaluator.
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const copy=value=>structuredClone(value);
const parser='acorn/8.15.0:owned-script/1';

export function validateScriptSequenceState(state,bundle,fail,{initial=false}={}){
  const sequence=state.control?.a0?.scriptSequence;
  if(bundle.entrySpec?.kind!=='scripts'){
    if(sequence!==undefined)fail('Script sequence has no declared script entry');
    return;
  }
  const sourceIds=bundle.entrySpec.sourceIds;
  if(!Array.isArray(sourceIds)||!sourceIds.length||new Set(sourceIds).size!==sourceIds.length||
     sourceIds.some(id=>typeof id!=='string'||!bundle.sources.some(source=>source.sourceId===id&&source.parser===parser)))
    fail('Invalid registered script sequence');
  if(!sequence||!equal(Object.keys(sequence).sort(),['environmentId','nextIndex','sourceIds'])||
     !equal(sequence.sourceIds,sourceIds)||!Number.isSafeInteger(sequence.nextIndex)||
     sequence.nextIndex<1||sequence.nextIndex>sourceIds.length||
     typeof sequence.environmentId!=='string'||
     state.envs[sequence.environmentId]?.parent!==state.control.a0.globalEnvId)
    fail('Invalid owned script sequence state');
  if(initial){
    const first=bundle.sources.find(source=>source.sourceId===sourceIds[0]);
    const frame=state.frames[state.control.a0.activeFrameId];
    if(sequence.nextIndex!==1||frame?.codeId!==first.entry||frame.envId!==sequence.environmentId||
       frame.callerFrameId!==null||frame.pc!==0||frame.status!=='running')
      fail('Initial script sequence does not start its first registered source');
  }
}

export function validateScriptSequenceEvent(before,event,bundle,fail){
  const sequence=before.control?.a0?.scriptSequence;
  const controlPatch=event.stateChanges.find(patch=>patch.table==='control'&&patch.id==='a0');
  if(event.operation!=='script.enter'){
    if(controlPatch&&!equal(controlPatch.after?.scriptSequence,sequence))
      fail('Script sequence changed outside a script entry');
    return;
  }
  validateScriptSequenceState(before,bundle,fail);
  const control=before.control.a0;
  if(!sequence||sequence.nextIndex>=sequence.sourceIds.length||control.activeFrameId!==null||
     control.queue.length||['failed','unsupported'].includes(control.status)||
     Object.values(before.effects).some(effect=>effect.dispatch==='prepared'))
    fail('Script entry preempted runnable or failed owned work');
  const source=bundle.sources.find(source=>source.sourceId===sequence.sourceIds[sequence.nextIndex]);
  const program=bundle.programs[source?.entry];
  if(source?.parser!==parser||!program||program.params?.length||program.patternNames?.length||
     program.generator||program.async||program.parameterExpressions)
    fail('Script entry does not reference an ordinary registered script program');
  const environment=before.envs[sequence.environmentId];
  const declarations=program.instructions.filter(inst=>inst.op==='DEF_FN').map(inst=>inst.arg.name);
  for(const name of [...program.varNames,...declarations]){
    const existing=environment.bindings[name];
    if(existing&&!['var','function'].includes(existing.kind))
      fail('Script entry overwrote an earlier lexical declaration');
  }
  const id=`f${before.counters.ids.frame+1}`;
  if(before.frames[id]||event.sourceId!==source.sourceId||event.codeId!==source.entry||
     event.siteId!==null||event.invocationId!==null||!equal(event.operands,[['str',source.sourceId]])||
     !equal(event.operandOrigins,[])||!equal(event.readObservations,[])||event.result!==null||
     !equal(event.causes,[{kind:'invocation',frameId:id}])||event.completion!==undefined||event.spec!==undefined)
    fail('Script entry source or invocation identity changed');
  const counter={...copy(before.counters.ids),frame:before.counters.ids.frame+1};
  const entered=copy(environment);
  for(const name of program.varNames)
    if(!Object.hasOwn(entered.bindings,name))entered.bindings[name]={kind:'var',initialized:true,
      token:{value:['undefined'],origin:null},version:0};
  const nextControl=copy(control);
  nextControl.activeFrameId=id;nextControl.scriptSequence.nextIndex++;
  nextControl.status='running';delete nextControl.completion;
  const frame={id,codeId:source.entry,pc:0,stack:[],envId:sequence.environmentId,
    callerFrameId:null,asyncPromiseId:null,status:'running',blockedOn:null,awaiting:null,
    operationId:null,pendingCoercionThrow:null,handlers:[],loops:[],thisValue:['undefined'],version:0};
  const expected=[];
  for(const [table,key,after] of [['counters','ids',counter],['envs',sequence.environmentId,entered],
    ['frames',id,frame],['control','a0',nextControl]]){
    const prior=Object.hasOwn(before[table],key)?before[table][key]:null;
    if(equal(prior,after))continue;
    after.version=(prior?.version??0)+1;
    expected.push({kind:`${table}.replace`,table,id:key,before:copy(prior),after});
  }
  if(!equal(event.stateChanges,expected))fail('Script entry state transition differs from independent declaration initialization');
}
