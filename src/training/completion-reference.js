// Independent, once-evaluated source observations. These receipts deliberately
// do not execute owned transition code and never inspect user properties.
import {parse} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {encode,decode} from '../values.js';

export const COMPLETION_OBSERVATION_SCHEMA='source-completions/1';
export const COMPLETION_HOOK='__tracingSourceCompletion';
const site=node=>node.start+':'+node.end;

export function completionObservationPlan(source){
  const ast=parse(source,{ecmaVersion:'latest',sourceType:'script'});
  const spans=[],insertions=[],sites=new Map(),finalizers=new Map();
  const add=(node,kind,expression=node,priority=0)=>{
    const key=site(node);sites.set(kind+':'+key,node);
    spans.push({start:expression.start,end:expression.end,kind,site:key,priority});
  };
  function visit(node,parent=null,depth=0){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child,parent,depth);return;}
    if(node.type==='Identifier'&&node.name===COMPLETION_HOOK)
      throw new TypeError('Reserved independent observation hook in source');
    const nested=depth+Number(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type));
    if(depth){
      if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&
        !['ForOfStatement','ForInStatement'].includes(parent?.parentType)){
        if(node.init)add(node,'initialize',node.init);
        else if(parent?.kind!=='var'){
          sites.set('initialize:'+site(node),node);
          insertions.push({at:node.end,text:'='+COMPLETION_HOOK+'('+JSON.stringify(site(node))+',"initialize",void 0)'});
        }
      }
      if(node.type==='AssignmentExpression'&&!['&&=','||=','??='].includes(node.operator))add(node,'assign',node,2);
      if(node.type==='CallExpression'&&!node.optional)add(node,'call',node,3);
      if(node.type==='ArrowFunctionExpression'&&node.body.type!=='BlockStatement')add(node.body,'return',node.body,-1);
      if(node.type==='ExpressionStatement'&&!node.directive)add(node,'statement',node.expression,-1);
      if(node.type==='ReturnStatement'||node.type==='ThrowStatement'){
        const kind=node.type==='ReturnStatement'?'return':'throw';
        if(node.argument)add(node,kind,node.argument,-1);
        else{
          sites.set(kind+':'+site(node),node);
          insertions.push({at:node.start+6,text:' '+COMPLETION_HOOK+'('+JSON.stringify(site(node))+',"return",void 0)'});
        }
      }
      if(node.type==='CatchClause'){
        const key=site(node.body);sites.set('catch:'+key,node);
        const value=node.param?.type==='Identifier'?node.param.name:'void 0';
        insertions.push({at:node.body.start+1,text:COMPLETION_HOOK+'('+JSON.stringify(key)+',"catch",'+value+');'});
      }
      if(node.type==='TryStatement'&&node.finalizer){
        const key=site(node.finalizer);finalizers.set(key,node.finalizer);
        insertions.push({at:node.finalizer.start+1,text:COMPLETION_HOOK+'('+JSON.stringify(key)+',"finally");'});
      }
      if(['BreakStatement','ContinueStatement'].includes(node.type)){
        const kind=node.type==='BreakStatement'?'break':'continue',key=site(node);
        sites.set(kind+':'+key,node);
        insertions.push({at:node.start,text:'{'+COMPLETION_HOOK+'('+JSON.stringify(key)+','+JSON.stringify(kind)+');'},
          {at:node.end,text:'}'});
      }
    }
    for(const [key,value] of Object.entries(node))if(!['start','end','loc','parentType'].includes(key)){
      if(value&&typeof value==='object'){
        const nextParent=node.type==='VariableDeclaration'?{...node,parentType:parent?.type}:node;
        visit(value,nextParent,nested);
      }
    }
  }
  visit(ast);
  return {spans,insertions,sites,finalizers};
}

export function instrumentCompletionSource(source){
  const {spans,insertions}=completionObservationPlan(source),opens=new Map(),closes=new Map(),extra=new Map();
  for(const span of spans){
    if(!opens.has(span.start))opens.set(span.start,[]);
    if(!closes.has(span.end))closes.set(span.end,[]);
    opens.get(span.start).push(span);closes.get(span.end).push(span);
  }
  for(const item of insertions)extra.set(item.at,(extra.get(item.at)??'')+item.text);
  let output='';
  for(let i=0;i<=source.length;i++){
    for(const span of (closes.get(i)??[]).sort((a,b)=>b.start-a.start||b.priority-a.priority))output+='))';
    output+=extra.get(i)??'';
    for(const span of (opens.get(i)??[]).sort((a,b)=>b.end-a.end||a.priority-b.priority))
      output+=COMPLETION_HOOK+'('+JSON.stringify(span.site)+','+JSON.stringify(span.kind)+',(';
    if(i<source.length)output+=source[i];
  }
  return output;
}

// Only type and identity are observed for references. No property access,
// serialization, coercion, iterator, getter or user function is invoked here.
export function createCompletionCapture({limit=32768,initialValues=[]}={}){
  if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError('Invalid observation limit');
  const observations=[],identities=new WeakMap();let next=0;
  const seed=value=>{
    if(value===null||!['object','function'].includes(typeof value)||identities.has(value))return;
    identities.set(value,++next);
    // Entry inputs were reconstructed from the declared data-only graph.
    // Seed every reachable identity so swapping two equal-looking arguments
    // cannot be hidden by first-observation renumbering. Never invoke a getter.
    const descriptors=Object.getOwnPropertyDescriptors(value);
    for(const key of Object.keys(descriptors).sort()){
      if(!Object.hasOwn(descriptors[key],'value'))throw new TypeError('Accessor in source observation input graph');
      seed(descriptors[key].value);
    }
  };
  for(const input of initialValues)seed(input);
  const capture=(site,kind,value)=>{
    if(observations.length>=limit)throw new RangeError('Source completion observation cap');
    const row={site,kind};
    if(!['finally','break','continue'].includes(kind)){
      if(value!==null&&['object','function'].includes(typeof value)){
        if(!identities.has(value))identities.set(value,++next);
        row.value=['identity',typeof value,identities.get(value)];
      }else row.value=encode(value);
    }
    observations.push(row);return value;
  };
  return {observations,capture};
}

export function ownedCompletionObservations(bundle,source){
  const plan=completionObservationPlan(source),siteById=new Map(bundle.sites.map(x=>[x.siteId,x]));
  const identities=new Map(),pending=new Map(),observations=[];let next=0;
  const state={heap:{...bundle.initialState.heap},envs:{...bundle.initialState.envs},frames:{...bundle.initialState.frames}};
  const seed=tag=>{
    if(!Array.isArray(tag)||tag[0]!=='ref'||identities.has(JSON.stringify(tag)))return;
    identities.set(JSON.stringify(tag),++next);
    const object=state.heap[tag[1]];
    if(!object||Object.keys(object.accessors??{}).length)throw new TypeError('Unobservable source input identity');
    for(const key of Object.keys(object.properties??{}).sort())seed(object.properties[key].value);
  };
  for(const argument of bundle.entrySpec?.arguments??[])seed(argument);
  const storedCell=(environment,name)=>{
    const seen=new Set();
    for(let id=environment;id!==null&&id!==undefined;id=state.envs[id]?.parent){
      if(seen.has(id))break;seen.add(id);
      const cell=state.envs[id]?.bindings?.[name];
      if(cell){
        if(!cell.initialized||!Array.isArray(cell.token?.value))return ['missing-storage'];
        return cell.token.value;
      }
    }
    throw new TypeError('Source binding has no committed cell');
  };
  const value=tag=>{
    if(!Array.isArray(tag))throw new TypeError('Missing owned source completion value');
    if(['undefined','null','bool','str','num','bigint','missing-storage'].includes(tag[0]))return tag;
    const key=JSON.stringify(tag);
    if(!identities.has(key))identities.set(key,++next);
    const kind=tag[0]==='ref'?bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object':
      tag[0]==='builtinfn'||tag[0]==='intrinsic'&&tag[1]!=='Math'&&tag[1]!=='Atomics'?'function':'object';
    return ['identity',kind,identities.get(key)];
  };
  const emit=(key,kind,tag)=>observations.push({site:key,kind,
    ...(!['finally','break','continue'].includes(kind)?{value:value(tag)}:{})});
  for(const event of bundle.events){
    const previousFrame=state.frames[event.invocationId];
    for(const change of event.stateChanges){
      if(!state[change.table])continue;
      if(change.after===null)delete state[change.table][change.id];
      else state[change.table][change.id]=change.after;
    }
    const location=siteById.get(event.siteId),key=location?site(location):null;
    const patch=event.stateChanges.find(p=>p.table==='frames'&&p.id===event.invocationId);
    const instructions=bundle.programs[event.codeId]?.instructions;
    const instruction=instructions?.find(x=>x.siteId===event.siteId);
    const abrupt=event.completion?.type==='throw';
    if(!abrupt&&['binding.initialize','binding.write'].includes(event.operation)&&plan.sites.has('initialize:'+key)){
      emit(key,'initialize',storedCell(previousFrame?.envId,instruction?.arg));
    }
    if(!abrupt&&['binding.write','property.write'].includes(event.operation)&&plan.sites.has('assign:'+key)){
      if(event.causes.some(c=>c.kind==='invocation'))
        pending.set(event.invocationId,{site:key,kind:'assign',depth:patch.after.stack.length,pc:patch.after.pc});
      else{
        // Check the committed cell value as well as expression completion. A
        // faulty teacher that stores a different value cannot hide behind a
        // correct assignment-expression result.
        let stored=event.result;
        if(event.operation==='binding.write')stored=storedCell(previousFrame?.envId,instruction?.arg);
        else{
          const [base,property]=event.operands??[];
          if(base?.[0]!=='ref'||!['str','num','bool','null','undefined','bigint'].includes(property?.[0]))
            throw new TypeError('Source assignment storage is outside the independently observed property profile');
          const object=state.heap[base[1]];
          if(!object||object.kind==='proxy')throw new TypeError('Source assignment storage requires an ordinary receiver');
          const key=String(decode(property));
          // A successful ordinary assignment must leave its stored value in
          // the receiver. Looking only at changed patches misses dropped writes.
          stored=object.properties?.[key]?.value??['missing-storage'];
        }
        emit(key,'assign',stored);
      }
    }
    if(!abrupt&&event.operation==='call.enter'&&plan.sites.has('call:'+key)&&!pending.has(event.invocationId)){
      if(!event.causes.some(c=>c.kind==='invocation')&&Array.isArray(event.result))emit(key,'call',event.result);
      else if(patch?.after)pending.set(event.invocationId,{site:key,kind:'call',depth:patch.after.stack.length,pc:patch.after.pc});
    }
    if(event.operation==='stack.pop'&&plan.sites.has('statement:'+key))emit(key,'statement',event.operands[0]);
    if(event.operation==='call.return'&&plan.sites.has('return:'+key))emit(key,'return',event.result);
    if(event.operation==='completion.throw'&&plan.sites.has('throw:'+key))emit(key,'throw',event.completion.value.value);
    if(event.operation==='completion.catch.bind'&&plan.sites.has('catch:'+key)){
      const node=plan.sites.get('catch:'+key);
      emit(key,'catch',node.param?storedCell(state.frames[event.invocationId]?.envId,node.param.name):['undefined']);
    }
    if(event.operation==='completion.loop.jump'&&plan.sites.has(instruction?.arg+':'+key))emit(key,instruction.arg);
    for(const change of event.stateChanges.filter(p=>p.table==='frames'&&p.before&&p.after)){
      const waiting=pending.get(change.id);
      if(waiting&&change.before.pc===waiting.pc){
        if(change.after.pc===waiting.pc&&change.after.stack.length>waiting.depth&&change.before.stack.length<=waiting.depth){
          emit(waiting.site,waiting.kind,change.after.stack[waiting.depth].value);pending.delete(change.id);
        }else if(change.after.pc!==waiting.pc||['thrown','unsupported'].includes(change.after.status))pending.delete(change.id);
      }
      for(const handler of change.after.handlers??[]){
        if(handler.phase!=='finally'||(change.before.handlers??[]).some(h=>h.finallyPc===handler.finallyPc&&h.afterPc===handler.afterPc&&h.phase==='finally'))continue;
        const end=bundle.programs[change.after.codeId]?.instructions[handler.afterPc-1];
        const finalizer=end?end.start+':'+end.end:null;
        if(plan.finalizers.has(finalizer))emit(finalizer,'finally');
      }
    }
  }
  if(pending.size)throw new TypeError('Incomplete owned source call/assignment observation');
  return observations;
}

export function compareCompletionObservations(expected,observed){
  if(!Array.isArray(expected)||!Array.isArray(observed))throw new TypeError('Completion receipts must be arrays');
  for(let index=0;index<Math.max(expected.length,observed.length);index++)
    if(!isDeepStrictEqual(expected[index],observed[index]))return {schema:COMPLETION_OBSERVATION_SCHEMA,
      status:'mismatch',checked:index,index,expected:expected[index]??null,observed:observed[index]??null};
  const counts={};for(const row of expected)counts[row.kind]=(counts[row.kind]??0)+1;
  return {schema:COMPLETION_OBSERVATION_SCHEMA,status:'agreed',checked:expected.length,counts,
    referenceValues:'scalars-and-input-rooted-reference-identity',
    uncovered:['intermediate-reference-property-snapshots','implicit-parameter-initialization','implicit-call-throws-without-a-catch-or-finally','Promise-job-internals']};
}
