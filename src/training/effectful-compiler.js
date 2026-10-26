// Certified projection of the owned interpreter's effectful journal. This is
// teacher authority only: serving never imports this module or its private
// archive. Public replay uses the same selected controller with adapters off.
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {validateBundle} from '../validation.js';
import {replayExact} from '../replay.js';
import {normalizeJournal,validateSemantic} from '../semantic/normalize.js';
import {describeOwnedGraph,realizeGraph,describeGraph} from './graph.js';
import {normalizeCompletionFacts} from './completion-facts.js';
import {SelectedExecutionHarness} from './harness-v4.js';
import {encodeWitness,decodeWitness,validateExpression} from './format.js';
import {hostOperation,SUBSCRIPTION_CLOSERS} from '../host/operations.js';
import {analyzeSemanticProgram} from './semantic-program.js';
import {sourceLinkedComputation,sourceLinkedDecision} from './semantic-source.js';

const copy=value=>structuredClone(value);
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const literal=value=>({op:'literal',value});
function refuse(message){const error=new Error('Effectful teacher projection: '+message);
  error.category='unsupported.witness-projection';throw error;}
const graphValue=value=>Array.isArray(value)&&['undefined','null','bool','str','num','bigint','ref','promise'].includes(value[0]);

function binarySourceNodes(source){
  const nodes=new Map();
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child);return;}
    if(['BinaryExpression','AssignmentExpression','Identifier','MemberExpression',
      'UnaryExpression','Literal','IfStatement','WhileStatement','DoWhileStatement',
      'ForStatement','ConditionalExpression'].includes(node.type))
      nodes.set(node.start+':'+node.end,node);
    for(const [key,value] of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));return nodes;
}

// Capture only names mentioned by this closure's source (including nested
// closures). The interpreter stores an entire environment chain; publishing
// unrelated cells would expose values the closure cannot read and can invent
// dependencies on unrelated function objects.
function closureReferences(source){
  const result=new Map();
  const functions=new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
  function references(node,names,parent=null,key=null){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)references(child,names,parent,key);return;}
    if(node.type==='Identifier'&&!(parent?.type==='MemberExpression'&&key==='property'&&!parent.computed)&&
      !(parent?.type==='Property'&&key==='key'&&!parent.computed&&!parent.shorthand)&&
      !(key==='id'||key==='params'||key==='label'))names.add(node.name);
    for(const [field,value] of Object.entries(node))if(!['start','end','loc'].includes(field))
      if(value&&typeof value==='object')references(value,names,node,field);
  }
  function visit(node){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child);return;}
    if(functions.has(node.type)){const names=new Set();references(node.body,names);result.set(node.start,names);}
    for(const value of Object.values(node))if(value&&typeof value==='object')visit(value);
  }
  visit(parse(source,{ecmaVersion:'latest'}));return result;
}

export function ownedEffectfulOutcome(bundle){
  // Async entry returns the Promise owned by the original entry frame. A
  // rejection does not complete the entire agent, and a later callback can
  // replace the agent's last completion. Neither is the root call's outcome.
  const entryId=bundle.initialState.control.a0.activeFrameId;
  const entry=bundle.initialState.frames[entryId],frame=bundle.finalState.frames[entryId];
  if(entry?.asyncPromiseId&&(frame?.asyncPromiseId!==entry.asyncPromiseId||
    !['completed','thrown'].includes(frame.status)))refuse('async root body has not completed');
  const root=entry?.asyncPromiseId?{kind:'return',value:['promise',entry.asyncPromiseId]}:
    bundle.finalState.control.a0.completion;
  if(!root)refuse('missing completed root outcome');
  let kind=root.kind,value=root.value;
  if(value?.[0]==='promise'){
    const promise=bundle.finalState.promises[value[1]];
    if(!promise||promise.status==='pending')refuse('root returned an unsettled Promise');
    kind=promise.status==='fulfilled'?'return':'throw';value=promise.value?.value;
  }
  if(!graphValue(value))refuse('completion is outside the declared data boundary');
  return {kind,graph:describeGraph(realizeGraph(bundle.finalState.heap,
    [...bundle.entrySpec.arguments,value]))};
}

export function compileEffectfulWitness(bundle,{sessionId='teacher1',programId='program1',
    invocationId='invocation1',trackId='worker1',realmId='realm1',sourceLineage=null,
    maxGenerated=16384,realmPolicy='retained',triggerId='teacher-entry',checkpointAtFirstAwait=false,
    representation='compact',maxOperators=8}={}){
  if(typeof checkpointAtFirstAwait!=='boolean')refuse('checkpointAtFirstAwait must be boolean');
  if(representation!=='compact')refuse('Only the canonical semantic trace is supported');
  if(!Number.isInteger(maxOperators)||maxOperators<1||maxOperators>8)
    refuse('compact expressions require an operator bound from 1 through 8');
  validateBundle(bundle);replayExact(bundle);
  const semantic=normalizeJournal(bundle);validateSemantic(bundle,semantic);
  const entry=bundle.entrySpec;
  if(entry?.kind!=='function')refuse('an explicit owned function entry is required');
  const source=bundle.sources.find(item=>item.sourceId===entry.sourceId)?.text;
  if(typeof source!=='string')refuse('exact source bytes are unavailable');
  const sourceReferences=closureReferences(source),functionReferences=new Map();
  const binaryNodes=binarySourceNodes(source),operationStarts=new Map();
  const privateSites=new Map(bundle.sites.map(site=>[site.siteId,site]));
  for(const event of bundle.events)for(const change of event.stateChanges)
    if(change.kind==='operation.create')operationStarts.set(change.id,{event,operation:change.record});
  const capabilities=[...new Set(analyzeSemanticProgram(source).sites.map(site=>site.operation).filter(Boolean))].sort();
  for(const operation of capabilities)hostOperation(operation);
  let harness=new SelectedExecutionHarness({sessionId,maxGenerated,automaticDelivery:false});
  harness.publishProgram({programId,source,entry:entry.functionName,capabilities,
    randomSeed:bundle.initialState.control.a0.randomSeed??null});
  // Rest parameters are ordinary arrays already created at the *entry*
  // boundary. They are neither source-provided positional arguments nor
  // later guest allocations. Include their descriptor-inspected identities
  // in the observed graph while preserving the actual argument root list.
  const entryEnvironment=bundle.initialState.envs[
    bundle.initialState.frames[semantic.rootInvocation]?.envId];
  const entryData=Object.values(entryEnvironment?.bindings??{}).flatMap(binding=>{
    const value=binding.initialized?binding.token?.value:null;
    return value?.[0]==='ref'&&['array','object'].includes(
      bundle.initialState.heap[value[1]]?.kind)?[value]:[];
  });
  const initial=describeOwnedGraph(bundle.initialState.heap,[...entry.arguments,...entryData]);
  const inputGraph={roots:initial.roots.slice(0,entry.arguments.length),objects:initial.objects.map(node=>({id:node.id,
    kind:node.kind,...(node.prototype===null?{prototype:null}:{}),
    properties:node.properties.map(({key,value})=>({key,value}))}))};
  // The admitted entry graph is descriptor-inspected ordinary data. A guest
  // allocation can have a getter or proxy-like behavior not encoded by the
  // public heap's basic property map; do not reconstruct it as a pure read.
  const certifiedDataIdentities=new Set(inputGraph.objects.map(node=>node.id));
  harness.admitInvocation({programId,invocationId,trackId,realmId,triggerId,
    inputGraph,realmPolicy,completionPolicy:'await-returned-promise'});
  const certificates=[],elided=[],checkpoints=[],rows=new Map(semantic.events.map(row=>[row.journalEvent,row]));
  const facts=normalizeCompletionFacts(bundle),state=copy(bundle.initialState);
  const roots=new Map([[semantic.rootInvocation,invocationId]]),frames=new Map([[semantic.rootInvocation,invocationId]]);
  const cellNames=new Map(),usedCellNames=new Set(),functionNames=new Map(),pendingAwaits=new Map(),callbackArrivals=[];
  const publicIdentities=new Map();
  const emittedPromises=new Set(),settledPromises=new Set(),returnedPromises=new Set(),reactionJobs=new Map();
  const reactionFrames=new Map(),reactionTargets=new Set(),microtasks=new Map(),privatePromises=new Set();
  const awaitingCompletion=new Map();
  const pendingComputations=[];
  let fusedComputations=0,foldedComputations=0,fusedBindings=0;
  let cellOrdinal=0,frameOrdinal=0,continuationOrdinal=0,eventOrdinal=0,generated=0,jobOrdinal=0;
  for(const program of Object.values(bundle.programs))for(const instruction of program.instructions)
    if(instruction.arg?.codeId&&['DEF_FN','MAKE_FUNCTION'].includes(instruction.op)){
      functionNames.set(instruction.arg.codeId,instruction.op==='DEF_FN'?
        instruction.arg.name:'function:'+instruction.start);
      functionReferences.set(instruction.arg.codeId,sourceReferences.get(instruction.start)??new Set());
    }
  const rootFor=frame=>roots.get(frame)??invocationId;
  const frameId=frame=>{if(!frames.has(frame))frames.set(frame,'guest'+(++frameOrdinal));return frames.get(frame);};
  const identity=id=>publicIdentities.get(id)??id;
  const tag=value=>{
    if(!graphValue(value))refuse('unrepresentable value '+JSON.stringify(value));
    return value[0]==='promise'?['ref',value[1]]:value[0]==='ref'?['ref',identity(value[1])]:copy(value);
  };
  const payload=effect=>{
    if(hostOperation(effect.operation).codec!=='owned-graph/1')return effect.request.payload;
    const graph=JSON.parse(effect.request.payload);
    const value=tag=>['ref','callback'].includes(tag[0])?[tag[0],identity(tag[1])]:tag;
    return JSON.stringify({...graph,roots:graph.roots.map(value),objects:graph.objects.map(node=>({
      ...node,id:identity(node.id),properties:node.properties.map(member=>({...member,value:value(member.value)}))
    }))});
  };
  const controller=owner=>harness.invocations.get(owner).controller;
  function publicScope(frame,owner){
    const selected=controller(owner),locals=selected.visibleLocals();
    return {
      locals,
      resolveLocal(name){
        // Shadowing follows the live owned lexical environment, not a
        // coincidental equal-valued local in another activation.
        for(let env=state.frames[frame]?.envId;env;env=state.envs[env]?.parent){
          if(!Object.hasOwn(state.envs[env]?.bindings??{},name))continue;
          const key=cellNames.get(env+':'+name);
          return key&&locals.has(key)?{name:key,value:locals.get(key)}:null;
        }
        return null;
      },
      hasOwnData(object,key){
        const node=selected.heap.get(object);
        return certifiedDataIdentities.has(object)&&
          ['object','array'].includes(node?.kind)&&node.properties.has(key);
      },
      readProperty:(object,key)=>selected.readProperty(object,key)
    };
  }
  const callbackRegistration=(effectId,functionId)=>{
    const effect=state.effects[effectId],callOwner=rootFor(effect?.frameId);
    const slots=hostOperation(effect.operation).callbackIndices.filter(slot=>
      effect.args[slot]?.[0]==='ref'&&effect.args[slot][1]===functionId);
    if(slots.length!==1)refuse('callback arrival lacks one exact declared native slot');
    const registration=harness.callbacks.get(callOwner+'/'+effectId+'/'+slots[0]);
    if(registration?.closureId!==identity(functionId))
      refuse('callback arrival differs from the native call registration');
    return registration;
  };
  const cell=(env,name)=>{
    const key=env+':'+name;
    if(!cellNames.has(key)){
      // Readable source-oriented cells are local semantic identities, not
      // references to VM environment IDs or an exact source/trace bijection.
      const stem=/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(name)?name:'value';
      let candidate=stem;
      while(usedCellNames.has(candidate))candidate=stem+'_'+(++cellOrdinal);
      usedCellNames.add(candidate);cellNames.set(key,candidate);
    }
    return cellNames.get(key);
  };
  function commitEmission(owner,kind,fields,certificate){
    if(++generated>maxGenerated)throw new RangeError('Effectful teacher record budget');
    const line=encodeWitness(kind,fields);
    harness.prepareModelContext(owner);
    harness.selected(owner,line);
    const receipt=harness.timeline.findLast(item=>item.kind==='semantic'&&item.invocationId===owner);
    certificates.push({sequence:receipt.sequence,...certificate,digest:hash(line)});
    return line;
  }
  function flushComputations(){
    for(const item of pendingComputations)commitEmission(item.owner,'compute',item.fields,item.certificate);
    pendingComputations.length=0;
  }
  function pendingBinding(row,event){
    if(!['binding.initialize','binding.write'].includes(event.operation)||
       row?.op!=='value'||row.writes?.length!==1||row.writes[0].kind!=='cell')
      return null;
    const last=pendingComputations.at(-1),write=row.writes[0];
    if(!last||last.fields.bind||last.owner!==rootFor(row.invocation)||
       last.fields.invocation!==frameId(row.invocation)||
       !row.dependsOn.includes(rows.get(last.producer)?.id)||
       !graphValue(write.value)||!isDeepStrictEqual(tag(write.value),last.fields.result))
      return null;
    return {last,write};
  }
  function emit(owner,kind,fields,event=null,rule=kind){
    const certificate={rule:'owned-'+rule+'/4',journalEvents:event?[event.eventId]:[],
      source:event?.siteId?{sourceId:event.sourceId,siteId:event.siteId}:null};
    // Only external requests need model-predicted source coordinates for
    // authorization. Pure calculations and choices keep source spans solely
    // in the private certificate; their public explanation is the expression.
    const sourceSite=event?.siteId&&privateSites.get(event.siteId);
    const node=sourceSite&&binaryNodes.get(sourceSite.start+':'+sourceSite.end);
    const start=event&&operationStarts.get(event.causes.find(cause=>cause.kind==='spec-operation')?.operationId);
    const pure=kind==='compute'&&!fields.bind&&
      fields.expr.op==='binary'&&node?.type==='BinaryExpression'&&
      node.operator===fields.expr.operator&&start&&
      start.event.sequence<event.sequence&&start.event.invocationId===event.invocationId&&
      start.event.siteId===event.siteId&&start.operation.operator===node.operator&&
      start.operation.operands.length===2&&[fields.expr.left,fields.expr.right].every(operand=>
        operand.op==='local'||operand.op==='read'||
        operand.op==='literal'&&!['ref','promise'].includes(operand.value[0]));
    if(!pure){flushComputations();return commitEmission(owner,kind,fields,certificate);}
    const item={owner,fields:copy(fields),certificate,node,producer:event.eventId};
    // The immediate source child and the recorded operand producer must both
    // identify this prior calculation. Coincidentally equal values cannot
    // establish this relationship, and unrelated calculations cannot be
    // skipped to find a convenient matching value farther back in the trace.
    for(;;){
      const previous=pendingComputations.at(-1);
      if(!previous||previous.owner!==owner||previous.fields.invocation!==fields.invocation)break;
      const side=['left','right'].find((side,index)=>node[side].start===previous.node.start&&
        node[side].end===previous.node.end&&start.operation.operands[index].origin===previous.producer&&
        item.fields.expr[side].op==='literal');
      if(!side)break;
      if(!isDeepStrictEqual(item.fields.expr[side].value,previous.fields.result))
        refuse('source dependency producer value disagrees with its committed operand');
      const expr={...item.fields.expr,[side]:previous.fields.expr};
      try{validateExpression(expr,{maxOperators});}catch{break;}
      pendingComputations.pop();fusedComputations++;
      item.fields.expr=expr;
      item.certificate={...certificate,rule:'owned-compact-compute/4',
        journalEvents:[...new Set([...previous.certificate.journalEvents,...item.certificate.journalEvents])],
        dependencies:[...(previous.certificate.dependencies??[]),...(item.certificate.dependencies??[]),
          {producer:previous.producer,consumer:event.eventId,operand:side,
            producerSpan:{start:previous.node.start,end:previous.node.end},
            consumerSpan:{start:node.start,end:node.end}}]};
    }
    pendingComputations.push(item);
    return encodeWitness('compute',item.fields);
  }
  function deliver(owner,effectId,options,event){
    if(harness.intents.get(owner+'/'+effectId)?.status!=='uncertain')
      return harness.deliverResult(owner,effectId,options);
    harness.reconcile(owner,effectId,{...options,disposition:options.status,
      evidenceId:'owned-delivery:'+event.eventId});
    return harness.timeline.findLast(item=>item.kind==='result'&&
      item.invocationId===owner&&item.effectId===effectId);
  }
  function promise(id,owner,event=null){
    if(emittedPromises.has(id)||privatePromises.has(id))return;
    emit(owner,'promise',{action:'create',promise:id},event,'promise-create');emittedPromises.add(id);
  }
  function seedBindings(frame,owner,event=null){
    const actual=state.frames[frame],env=state.envs[actual?.envId];
    for(const [name,binding] of Object.entries(env?.bindings??{}))if(binding.initialized&&graphValue(binding.token?.value)){
      const value=tag(binding.token.value),nameId=cell(actual.envId,name);
      if(!controller(owner).locals.has(nameId))emit(owner,'bind',{name:nameId,value},event,'parameter-binding');
    }
  }
  function writes(row,owner,event){
    for(const change of row.writes??[]){
      if(change.kind==='cell'){
        if(!graphValue(change.value))refuse('unrepresentable captured cell');
        emit(owner,'bind',{name:cell(change.env,change.key),value:tag(change.value)},event,'cell-write');
      }else if(change.kind==='property')emit(owner,'write',{object:identity(change.object),key:change.key,
        present:change.present,value:change.present?tag(change.value):['undefined']},event,'property-write');
      else refuse('unknown mutation family');
    }
  }
  function allocations(row,owner,event){
    for(const allocation of row.allocations??[]){
      if(controller(owner).heap.has(identity(allocation.identity)))continue;
      const fields={name:identity(allocation.identity),kind:allocation.kind==='function'?'closure':allocation.kind,
        properties:allocation.kind==='function'?[]:allocation.properties.filter(p=>p.key!=='length'||allocation.kind!=='array')
          .map(({key,value})=>({key,value:tag(value)}))};
      if(allocation.kind==='array')fields.length=allocation.properties.find(p=>p.key==='length')?.value?.[1];
      if(allocation.kind==='function'){
        fields.code=functionNames.get(allocation.codeId);
        if(!fields.code)refuse('closure source identity is absent');
        fields.captures=[];
        const capturedNames=new Set();
        for(let env=allocation.capture;env;env=state.envs[env]?.parent)
          for(const [name,binding] of Object.entries(state.envs[env]?.bindings??{}))
            if(functionReferences.get(allocation.codeId)?.has(name)&&!capturedNames.has(name)&&
              binding.initialized&&graphValue(binding.token?.value)){
              capturedNames.add(name);
              const id=cell(env,name);
              if(!controller(owner).locals.has(id))emit(owner,'bind',{name:id,value:tag(binding.token.value)},event,'capture-binding');
              fields.captures.push({binding:name,cell:id});
            }
      }
      emit(owner,'allocate',fields,event,'allocate');
    }
  }
  // Initial owned result Promises are part of entering an async function, not
  // external observations or values taken from its eventual final heap.
  for(const id of Object.keys(bundle.initialState.promises))promise(id,invocationId);
  seedBindings(semantic.rootInvocation,invocationId);
  for(const event of bundle.events){
    // Private housekeeping can separate adjacent semantic computations, but
    // mutation, control, observation, call/job activation and cleanup cannot.
    // These boundaries flush even when they have no standalone public row.
    const row=rows.get(event.eventId),fact=facts.get(event.eventId);
    const pureTransition=['binding.read','literal.materialize','primitive.binary'].includes(event.operation)||
      event.operation.startsWith('spec.');
    // A branch has no independent guest mutation. Keep its immediately
    // preceding pure test pending so a checked condition can replace it.
    // Likewise, an exact producer-dependent cell initialization can become
    // the binding of its computation without an extra model target.
    const possibleChoice=row?.op==='branch';
    const attachBinding=pendingBinding(row,event);
    if(!possibleChoice&&!attachBinding&&(!pureTransition||
      event.completion&&event.completion.type!=='normal'||
      event.stateChanges.some(change=>['envs','heap','effects','inputs','promises','control'].includes(change.table))))
      flushComputations();
    let owner=rootFor(event.invocationId),handled=false;
    const promiseChanges=event.stateChanges.filter(change=>change.table==='promises');
    const effectCreated=event.stateChanges.find(change=>change.table==='effects'&&change.before===null);
    const queued=state.control.a0.queue?.[0];
    if(event.operation==='job.enter'&&queued?.kind==='reaction'&&queued.reaction.kind==='finally')
      for(const change of promiseChanges)if(change.before===null&&
        change.after.observers?.some(observer=>observer.kind==='finally-pass'))privatePromises.add(change.id);
    const declaredTargets=new Set();
    if(event.operation!=='job.enter'){
      for(const change of promiseChanges)for(const observer of change.after?.observers??[])
        if(observer.kind==='reaction')declaredTargets.add(observer.reaction.resultId);
      const control=event.stateChanges.find(change=>change.table==='control');
      for(const job of control?.after?.queue??[])if(job.kind==='reaction')
        declaredTargets.add(job.reaction.resultId);
    }
    // Only source-generated promise creation is a prediction. An external
    // request declares its own promise identity in the same atomic record.
    for(const change of promiseChanges)if(change.before===null&&change.id!==effectCreated?.after?.promiseId&&
      !declaredTargets.has(change.id))
      promise(change.id,owner,event);
    function registerReaction(promiseId,reaction){
      if(reactionJobs.has(reaction.resultId))return;
      const job='reaction'+(++jobOrdinal),isFinally=reaction.kind==='finally';
      const fields={action:'react',promise:promiseId,job,reaction:isFinally?'finally':
        reaction.onFulfilled?.[0]==='ref'?'then':reaction.onRejected?.[0]==='ref'?'catch':'then',
        target:reaction.resultId};
      const closure=isFinally?reaction.onFinally:fields.reaction==='catch'?reaction.onRejected:reaction.onFulfilled;
      if(closure?.[0]==='ref')fields.closure=identity(closure[1]);
      if(fields.reaction==='then'&&reaction.onRejected?.[0]==='ref')fields.rejectionClosure=identity(reaction.onRejected[1]);
      emit(owner,'promise',fields,event,'promise-reaction');
      emittedPromises.add(reaction.resultId);
      reactionTargets.add(reaction.resultId);reactionJobs.set(reaction.resultId,{job,owner,target:reaction.resultId});
    }
    if(event.operation!=='job.enter'){
      for(const change of promiseChanges)for(const observer of change.after?.observers??[])
        if(observer.kind==='reaction')registerReaction(change.id,observer.reaction);
      const control=event.stateChanges.find(change=>change.table==='control');
      const oldQueue=control?.before?.queue??[],newQueue=control?.after?.queue??[];
      if(newQueue.length>oldQueue.length)for(const job of newQueue.slice(oldQueue.length)){
        if(job.kind==='reaction')registerReaction(job.promiseId,job.reaction);
        if(job.kind==='microtask'){
          const id='microtask'+(++jobOrdinal);
          emit(owner,'job',{action:'enqueue',job:id,owner,closure:identity(job.functionId)},event,'microtask-enqueue');
          if(!microtasks.has(job.functionId))microtasks.set(job.functionId,[]);
          microtasks.get(job.functionId).push({job:id,owner});
        }
      }
    }
    if(event.operation==='external.callback.enqueue'){
      const queue=event.stateChanges.find(change=>change.table==='control')?.after?.queue??[];
      const callback=queue.at(-1);
      if(callback?.kind!=='external-callback')refuse('callback lacks owned queue receipt');
      const eventId='teacherevent'+(++eventOrdinal);
      const registration=callbackRegistration(callback.effectId,callback.functionId);
      harness.postEvent({subscriptionId:registration.subscriptionId,eventId,
        args:realizeGraph(state.heap,callback.args),completionPolicy:'await-returned-promise',deliver:false});
      callbackArrivals.push({...copy(callback),eventId,subscriptionId:registration.subscriptionId});
      handled=true;
    }else if(event.operation==='effect.dispatch'){
      const effectId=event.causes.find(cause=>cause.kind==='effect')?.effectId;
      const effect=state.effects[effectId],requestOwner=rootFor(effect?.frameId);
      const key=requestOwner+'/'+effectId,intent=harness.intents.get(key);
      if(!effect||intent?.status!=='committed'||intent.operation!==effect.operation||intent.payload!==payload(effect))
        refuse('native dispatch is not grounded in the selected request');
      intent.status='dispatched';intent.attempts++;
      harness.record('observed','dispatch',harness.invocations.get(requestOwner).trackId,
        {invocationId:requestOwner,effectId,key,attempt:intent.attempts});
      for(const registration of harness.callbacks.values())if(registration.ownerInvocationId===requestOwner&&
          harness.callbacks.get(key+'/'+registration.slot)===registration)
        harness.registerEventHandler({subscriptionId:registration.subscriptionId,programId,
          realmId,trackId,entry:registration.entry,closureId:registration.closureId,
          lifetime:registration.lifetime,ownerInvocationId:requestOwner,realmPolicy:'retained'});
      certificates.push({sequence:harness.timeline.at(-1).sequence,rule:'native-dispatch/4',
        journalEvents:[event.eventId],digest:hash(effect.request)});handled=true;
    }else if(row?.op==='request'){
      const effect=effectCreated.after;
      const fields={effect:row.effect,operation:row.operation,arguments:row.arguments.map(tag),
        invocation:frameId(row.invocation),site:{start:row.source.start,end:row.source.end},payload:payload(effect)};
      if(effect.promiseId){fields.promise=effect.promiseId;emittedPromises.add(effect.promiseId);}
      emit(owner,'request',fields,event,'request');handled=true;
    }else if(row?.op==='observe'){
      const input=event.stateChanges.find(change=>change.table==='inputs')?.after;
      const effect=state.effects[row.effect];owner=rootFor(effect.frameId);
      const status=input?.abrupt?'rejected':'fulfilled';
      const introduced=event.stateChanges.filter(change=>change.table==='heap'&&change.before===null);
      let receipt;
      if(introduced.length){
        const deliveredHeap={...state.heap,...Object.fromEntries(introduced.map(change=>[change.id,change.after]))};
        const graph=describeOwnedGraph(deliveredHeap,[row.result]);
        receipt=deliver(owner,row.effect,{status,
          value:realizeGraph(deliveredHeap,[row.result])[0],errorOrigin:status==='rejected'?'adapter-rejection':null},event);
        const observed=decodeWitness(receipt.line).fields.graph;
        if(observed.objects.length!==graph.objects.length)refuse('external graph topology changed during delivery');
        for(const [index,node] of graph.objects.entries())publicIdentities.set(node.id,observed.objects[index].id);
      }else receipt=deliver(owner,row.effect,{status,result:tag(row.result),
        errorOrigin:status==='rejected'?'adapter-rejection':null},event);
      if(effect.promiseId)settledPromises.add(effect.promiseId);
      certificates.push({sequence:receipt.sequence,rule:'observed-delivery/4',
        journalEvents:[event.eventId],digest:hash(receipt.line)});
      if(status==='fulfilled'&&SUBSCRIPTION_CLOSERS[effect.operation]){
        // Closing comes from the native result's independently audited owned
        // mutation. A guessed token or a model-selected line cannot revoke a
        // handler, and queued arrivals for that exact registration are dropped.
        for(const change of event.stateChanges)if(change.table==='effects'&&
            change.before?.subscription?.state==='active'&&change.after?.subscription?.state==='closed'&&
            change.after.subscription.closedBy===effect.id){
          const registrationOwner=rootFor(change.before.frameId);
          for(const slot of hostOperation(change.before.operation).callbackIndices){
            const registration=harness.callbacks.get(registrationOwner+'/'+change.id+'/'+slot);
            if(!registration)refuse('native unsubscribe lacks selected registration ownership');
            const closed=harness.closeEventHandler(registration.subscriptionId);
            certificates.push({sequence:closed.sequence,rule:'observed-subscription-close/4',
              journalEvents:[event.eventId],digest:hash({subscriptionId:registration.subscriptionId,
                effectId:effect.id,token:change.before.subscription.token})});
          }
          for(let index=callbackArrivals.length-1;index>=0;index--)
            if(callbackArrivals[index].effectId===change.id)callbackArrivals.splice(index,1);
        }
      }
      handled=true;
    }else if(row?.op==='await'){
      const continuation='continuation'+(++continuationOrdinal),frame=state.frames[row.invocation];
      const fields={promise:row.promise,continuation,invocation:frameId(row.invocation)};
      if(frame.asyncPromiseId&&row.invocation===semantic.rootInvocation&&!returnedPromises.has(frame.asyncPromiseId)){
        fields.returnPromise=frame.asyncPromiseId;returnedPromises.add(frame.asyncPromiseId);
      }
      emit(owner,'await',fields,event,'await');pendingAwaits.set(row.invocation,{continuation,promise:row.promise});
      if(checkpointAtFirstAwait&&!checkpoints.length){
        if([...harness.handlers.values()].some(handler=>handler.state!=='closed'))
          refuse('native listener checkpoint needs explicit reattachment evidence absent from this source journal');
        const packet=JSON.parse(JSON.stringify(harness.checkpoint()));
        harness=SelectedExecutionHarness.restore(packet);
        harness.evictSource(trackId,programId);
        harness.restoreSource(trackId,programId,{digest:harness.programs.get(programId).digest});
        checkpoints.push({schema:'semantic-checkpoint-evidence/4',journalEvent:event.eventId,
          publicSequence:packet.globalSequence,integrity:packet.integrity,
          sourceDigest:harness.programs.get(programId).digest,
          uncertainIntents:[...harness.intents].filter(([,intent])=>intent.status==='uncertain').map(([key])=>key),
          publicReplayValidated:true,nativeRedispatches:0});
      }
      handled=true;
    }else if(event.operation==='job.enter'){
      const changed=event.stateChanges.find(change=>change.table==='frames'&&
        (change.after?.status==='running'||change.before?.status==='suspended'&&change.after?.status==='thrown'));
      const queue=state.control.a0.queue?.[0];
      if(changed?.before?.status==='suspended'){
        owner=rootFor(changed.id);
        const pending=pendingAwaits.get(changed.id),settled=state.promises[pending?.promise];
        if(!pending||!settled||settled.status==='pending')refuse('resumed job lacks a settled dependency');
        emit(owner,'resume',{continuation:pending.continuation,invocation:frameId(changed.id),
          result:tag(settled.value.value),status:settled.status},event,'resume');pendingAwaits.delete(changed.id);
      }else if(changed?.before===null&&queue?.kind==='external-callback'){
        const arrival=callbackArrivals.shift();
        if(!arrival||arrival.effectId!==queue.effectId||arrival.functionId!==queue.functionId)
          refuse('callback activation order disagrees with arrival receipt');
        const registration=callbackRegistration(queue.effectId,queue.functionId);
        const activation=harness.deliverReadyEvents(registration.subscriptionId);
        if(!activation)refuse('callback activation was not eligible at owned checkpoint');
        owner=activation.invocationId;roots.set(changed.id,owner);frames.set(changed.id,owner);
      }else if(changed?.before===null&&['reaction','microtask'].includes(queue?.kind)){
        // Promise reactions are ordinary owned closure activations at a job
        // boundary. They use the shared selected heap; no native guest call.
        const registration=queue.kind==='reaction'?reactionJobs.get(queue.reaction.resultId):
          microtasks.get(queue.functionId)?.shift();
        if(!registration)refuse('reaction job lacks a projected registration');
        owner=registration.owner;
        emit(owner,'job',{action:'dispatch',job:registration.job,owner},event,'job-dispatch');
        roots.set(changed.id,owner);frames.set(changed.id,'job:'+registration.job);
        reactionFrames.set(changed.id,registration);
      }else if(!changed&&queue?.kind==='reaction'){
        const registration=reactionJobs.get(queue.reaction.resultId);
        if(!registration)refuse('pass-through reaction lacks registration');
        owner=registration.owner;
        emit(owner,'job',{action:'dispatch',job:registration.job,owner},event,'job-dispatch');
        emit(owner,'job',{action:'complete',job:registration.job,owner},event,'job-complete');
      }else if(!changed&&queue?.kind==='finally-pass'){
        // The selected job's cleanup/adoption rule already retains the original
        // outcome or the cleanup failure. This private forwarding job has no
        // independent guest code, new effect or observation.
        handled=true;
      }else refuse('unknown owned job activation');
      handled=true;
    }else if(row?.op==='call'){
      roots.set(row.child,owner);
      allocations(row,owner,event);
      emit(owner,'call',{child:frameId(row.child),callee:functionNames.get(row.code)??row.code,
        receiver:tag(row.receiver),arguments:row.arguments.map(tag)},event,'call');writes(row,owner,event);handled=true;
    }else if(row?.op==='alloc'){
      allocations(row,owner,event);writes(row,owner,event);handled=true;
    }else if(row?.op==='value'&&event.operation==='call.enter'&&row.operands.length===1&&
        isDeepStrictEqual(row.operands[0]?.[0]==='method'?row.operands[0][1]:row.operands[0],
          ['builtinfn','Math.random'])){
      // Retain every owned PRNG transition, including an otherwise discarded
      // sample. A literal result would erase the dependency on prior samples.
      emit(owner,'compute',{expr:{op:'random'},result:tag(row.result),
        invocation:frameId(row.invocation)},event,'random');
      writes(row,owner,event);handled=true;
    }else if(row?.op==='value'&&row.arithmetic){
      const operands=row.operands.map(value=>tag(Array.isArray(value)?value:value.value));
      if(operands.length!==2)refuse('binary computation lacks evaluated operands');
      const sourceNode=row.source&&binaryNodes.get(row.source.start+':'+row.source.end);
      const expr=sourceLinkedComputation({op:'binary',operator:row.arithmetic.operator,
        left:literal(operands[0]),right:literal(operands[1])},
        sourceNode,publicScope(row.invocation,owner));
      emit(owner,'compute',{expr,result:tag(row.result),
        invocation:frameId(row.invocation)},event,'compute');
      writes(row,owner,event);handled=true;
    }else if(row?.op==='branch'){
      const sourceNode=row.source&&binaryNodes.get(row.source.start+':'+row.source.end);
      const testNode=['IfStatement','WhileStatement','DoWhileStatement','ForStatement',
        'ConditionalExpression'].includes(sourceNode?.type)?sourceNode.test:sourceNode;
      const decision=tag(row.test);
      const explained=sourceLinkedDecision(sourceNode,decision,publicScope(row.invocation,owner),
        {maxOperators});
      // Never erase a bound computation or one performed elsewhere. Every
      // removed primitive must be the consecutive, source-contained producer
      // of this very decision; its journal receipt stays on the choice.
      let folded=[];
      if(explained&&testNode&&pendingComputations.length&&
         isDeepStrictEqual(pendingComputations.at(-1).fields.result,decision)&&
         pendingComputations.at(-1).node?.start===testNode.start&&
         pendingComputations.at(-1).node?.end===testNode.end&&
         pendingComputations.every(item=>item.owner===owner&&!item.fields.bind&&
           item.fields.invocation===frameId(row.invocation)&&item.node&&
           item.node.start>=testNode.start&&item.node.end<=testNode.end)){
        folded=pendingComputations.splice(0);
      }
      emit(owner,'choose',{expr:explained??literal(decision),decision,path:row.path,
        invocation:frameId(row.invocation)},event,'branch');
      if(folded.length){
        const certificate=certificates.at(-1);
        certificate.rule='owned-source-choice/4';
        certificate.journalEvents=[...new Set([
          ...folded.flatMap(item=>item.certificate.journalEvents),...certificate.journalEvents])];
        certificate.dependencies=folded.flatMap(item=>item.certificate.dependencies??[]);
        foldedComputations+=folded.length;
      }
      handled=true;
    }else if(row?.op==='write'||row?.op==='value'){
      if(attachBinding){
        attachBinding.last.fields.bind=cell(attachBinding.write.env,attachBinding.write.key);
        // Keep source-operation dependency receipts separate from the cell
        // attachment. The same expression proof must still have exactly the
        // actual operand producer edges, while the appended binding has its
        // own source receipt and lexical identity.
        if(attachBinding.last.certificate.rule!=='owned-compact-compute/4')
          attachBinding.last.certificate.rule='owned-compact-bind/4';
        attachBinding.last.certificate.binding={
          name:attachBinding.last.fields.bind,journalEvent:event.eventId,
          producer:attachBinding.last.producer};
        flushComputations();fusedBindings++;
      }else writes(row,owner,event);
      handled=true;
    }else if(row?.op==='read'){
      for(const read of row.reads??[])if(read.kind==='property'&&controller(owner).heap.has(identity(read.objectId??read.object))){
        const object=identity(read.objectId??read.object),key=read.key??read.property;
        if(typeof key==='string'&&graphValue(read.value))emit(owner,'read',{object,key,
          present:read.present??true,value:tag(read.value)},event,'read');
      }
      handled=true;
    }else if(row?.op==='carry'){
      for(const relation of row.copies??[{from:row.from,to:row.to}]){
        const from=cell(relation.from.env,relation.from.key),to=cell(relation.to.env,relation.to.key);
        const read=row.reads.find(r=>r.envId===relation.from.env&&r.name===relation.from.key);
        emit(owner,'bind',{name:to,value:tag(read.value),...(controller(owner).locals.has(from)?{from}:{})},event,'iteration-cell');
      }
      handled=true;
    }
    // Promise resolution is generated exactly where the journal changes it;
    // externally caused settlements have already entered as observations.
    for(const change of promiseChanges){
      if(event.operation==='external.input.deliver')continue;
      if(privatePromises.has(change.id)||reactionTargets.has(change.id))continue;
      const publicPromise=controller(owner).heap.get(change.id);
      if(['fulfilled','rejected'].includes(change.after?.status)&&publicPromise?.state===change.after.status&&
        isDeepStrictEqual(publicPromise.result,tag(change.after.value.value))){settledPromises.add(change.id);continue;}
      if(change.after?.adopting&&change.before?.adopting!==change.after.adopting){
        emit(owner,'promise',{action:'adopt',promise:change.id,target:change.after.adopting},event,'promise-adoption');
      }else if(['fulfilled','rejected'].includes(change.after?.status)&&
          change.before?.status!==change.after.status&&!settledPromises.has(change.id)){
        emit(owner,'promise',{action:change.after.status==='fulfilled'?'resolve':'reject',
          promise:change.id,value:tag(change.after.value.value)},event,'promise-settlement');
        settledPromises.add(change.id);
      }
    }
    if(fact?.operation==='catch-bind'){
      const env=event.stateChanges.find(change=>change.table==='envs'&&change.before===null)?.id;
      emit(owner,'bind',{name:cell(env,fact.name),value:tag(fact.value)},event,'catch-binding');handled=true;
    }else if(fact?.operation==='transfer'){
      emit(owner,'transfer',{kind:fact.kind,value:tag(fact.value),handler:fact.handler,
        invocation:frameId(fact.invocation)},event,'completion-transfer');handled=true;
    }else if(['return','throw','unhandled-throw'].includes(fact?.operation)){
      if(row)writes(row,owner,event);
      const frame=state.frames[fact.invocation],asyncResult=frame?.asyncPromiseId;
      const value=asyncResult?['ref',asyncResult]:tag(fact.value??event.operands?.[0]);
      const kind=asyncResult?'return':fact.operation==='return'?'return':'throw';
      emit(owner,kind,{value,invocation:frameId(fact.invocation)},event,'completion');
      if(reactionFrames.has(fact.invocation)){
        const job=reactionFrames.get(fact.invocation);
        emit(owner,'job',{action:'complete',job:job.job,owner},event,'job-complete');
      }else if(frames.get(fact.invocation)===owner)awaitingCompletion.set(owner,kind);
      handled=true;
    }
    if(!handled&&row?.op!=='loop'){
      if(row)refuse('unprojected semantic family '+row.op);
      elided.push({journalEvent:event.eventId,operation:event.operation,reason:'private-machine-transition'});
    }
    for(const change of event.stateChanges){
      if(change.after===null)delete state[change.table][change.id];
      else state[change.table][change.id]=copy(change.after);
    }
    if(event.operation==='job.enter'){
      const created=event.stateChanges.find(change=>change.table==='frames'&&change.before===null);
      if(created)seedBindings(created.id,rootFor(created.id),event);
    }
    for(const [pendingOwner,kind] of awaitingCompletion){
      const c=controller(pendingOwner);
      if(c.stack.length||c.ready.length||[...c.jobs.values()].some(job=>job.status!=='completed')||
        [...c.continuations.values()].some(continuation=>continuation.state!=='resumed')||
        [...c.effects.values()].some(effect=>effect.status==='requested'))continue;
      emit(pendingOwner,'end',{kind},event,'completion');awaitingCompletion.delete(pendingOwner);
    }
  }
  flushComputations();
  const exported=harness.exportEpisode({sourceLineage});
  if(checkpointAtFirstAwait&&!checkpoints.length)refuse('checkpoint profile requires an actual source await');
  exported.sidecar.selectionOrigin='owned-interpreter-teacher';
  exported.sidecar.referenceStatus='unverified';
  exported.sidecar.admission='projected';
  exported.sidecar.representation='compact';
  exported.sidecar.compiler={schema:'semantic-effectful-compiler/4',certificates,elided,checkpoints,
    sourceDigest:hash(source),archiveDigest:hash(bundle),capabilities,
    representation:'compact',compaction:{maxOperators,maxNodes:32,removedComputations:fusedComputations,
      foldedConditions:foldedComputations,fusedBindings},
    generatedRecords:generated,publicDigest:hash(exported.public)};
  const replayed=SelectedExecutionHarness.replay(exported);
  for(const activation of replayed.invocations.values())
    if(activation.controller.firstWitnessViolation)refuse('selected replay has an inconsistent computation');
  const expected=ownedEffectfulOutcome(bundle),selected=replayed.invocations.get(invocationId).controller;
  const observed={kind:selected.completion.kind,graph:selected.observedGraph()};
  if(!isDeepStrictEqual(expected,observed))refuse('selected replay differs from independently reconstructed owned outcome');
  return {exported,semantic,certificates,outcome:expected};
}

export function verifyEffectfulProjection(bundle,exported,options={}){
  const expected=compileEffectfulWitness(bundle,options);
  if(!isDeepStrictEqual(expected.exported.public,exported.public)||
    !isDeepStrictEqual(expected.exported.sidecar.compiler,exported.sidecar.compiler)||
    expected.exported.sidecar.representation!==exported.sidecar.representation)
    throw new Error('Effectful teacher certificates or exact public bytes changed');
  return {valid:true,publicDigest:hash(exported.public),certificates:expected.certificates.length,
    generatedRecords:expected.exported.sidecar.compiler.generatedRecords,nativeReplayDispatches:0};
}
