// Independent, once-evaluated source observations. These receipts deliberately
// do not execute owned transition code and never inspect user properties.
import {parse} from 'acorn';
import {isDeepStrictEqual} from 'node:util';
import {encode} from '../values.js';

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
      if(node.type==='AssignmentExpression'&&node.operator==='=')add(node,'assign',node,2);
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
export function createCompletionCapture({limit=32768}={}){
  if(!Number.isSafeInteger(limit)||limit<1)throw new TypeError('Invalid observation limit');
  const observations=[],identities=new WeakMap();let next=0;
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
  const value=tag=>{
    if(!Array.isArray(tag))throw new TypeError('Missing owned source completion value');
    if(['undefined','null','bool','str','num','bigint'].includes(tag[0]))return tag;
    const key=JSON.stringify(tag);
    if(!identities.has(key))identities.set(key,++next);
    const kind=tag[0]==='ref'?bundle.finalState.heap[tag[1]]?.kind==='function'?'function':'object':
      tag[0]==='builtinfn'||tag[0]==='intrinsic'&&tag[1]!=='Math'&&tag[1]!=='Atomics'?'function':'object';
    return ['identity',kind,identities.get(key)];
  };
  const emit=(key,kind,tag)=>observations.push({site:key,kind,
    ...(!['finally','break','continue'].includes(kind)?{value:value(tag)}:{})});
  for(const event of bundle.events){
    const location=siteById.get(event.siteId),key=location?site(location):null;
    const patch=event.stateChanges.find(p=>p.table==='frames'&&p.id===event.invocationId);
    const instructions=bundle.programs[event.codeId]?.instructions;
    const instruction=instructions?.find(x=>x.siteId===event.siteId);
    const abrupt=event.completion?.type==='throw';
    if(!abrupt&&['binding.initialize','binding.write'].includes(event.operation)&&plan.sites.has('initialize:'+key)){
      const env=event.stateChanges.find(p=>p.table==='envs'&&p.after?.bindings?.[instruction?.arg]);
      emit(key,'initialize',env?.after.bindings[instruction.arg].token.value??event.result);
    }
    if(!abrupt&&['binding.write','property.write'].includes(event.operation)&&plan.sites.has('assign:'+key)){
      if(event.causes.some(c=>c.kind==='invocation'))
        pending.set(event.invocationId,{site:key,kind:'assign',depth:patch.after.stack.length,pc:patch.after.pc});
      else{
        // Check the committed cell value as well as expression completion. A
        // faulty teacher that stores a different value cannot hide behind a
        // correct assignment-expression result.
        let stored=event.result;
        if(event.operation==='binding.write'){
          const env=event.stateChanges.find(p=>p.table==='envs'&&p.after?.bindings?.[instruction?.arg]);
          stored=env?.after.bindings[instruction.arg].token.value??stored;
        }else if(event.operands?.[1]?.[0]==='str'){
          const heap=event.stateChanges.find(p=>p.table==='heap'&&p.id===event.operands[0]?.[1]);
          stored=heap?.after?.properties?.[event.operands[1][1]]?.value??stored;
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
      emit(key,'catch',node.param?event.result:['undefined']);
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
    referenceValues:'scalars-and-first-observed-reference-identity',
    uncovered:['intermediate-reference-property-snapshots','implicit-parameter-initialization','implicit-call-throws-without-a-catch-or-finally','Promise-job-internals']};
}
