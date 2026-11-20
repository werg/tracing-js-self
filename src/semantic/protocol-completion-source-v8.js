// Source-only qualification of ordinary synchronous catch/finally scopes. The
// public record is the established detailed transfer; its handler payload keeps
// all active obligations, without exposing bytecode, operand stacks or PCs.
export const COMPLETION_SOURCE_PROFILE_V8='ordinary-completions-source/1';
const schema='semantic-handler-scopes/1',U=['undefined'];
const staticFields=['catchPc','finallyPc','afterPc','envId','stackDepth','loopDepth'];
const handlerFields=[...staticFields,'phase','pending','caught'];
export function createCompletionSourceAdapterV8({bundle}){
  if(!Object.values(bundle.programs).some(program=>!program.generator&&program.instructions.some(row=>row.op==='TRY_ENTER')))return null;
  const tracked=new Set(),scopes=new Map();let sequence=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('ordinary completion: '+message);};
  const instruction=(ctx,event)=>{
    const frame=ctx.getOwnedFrame(event.invocationId),inst=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
    return inst?.siteId===event.siteId?inst:null;
  };
  function completion(ctx,pending,event){
    if(pending===null)return null;
    require(ctx,pending&&['normal','return','throw'].includes(pending.type),'loop-target cleanup requires its declared target profile');
    const value=pending.type==='normal'?U:pending.value?.value;
    require(ctx,Array.isArray(value)&&value[0]!=='symbol','completion must have an ordinary public value');
    return {kind:pending.type,value:ctx.tag(value,event)};
  }
  function update(ctx,node,event){
    if(!tracked.has(node.id))return;
    require(ctx,!node.generatorId&&!node.asyncPromiseId&&!node.awaiting,'only ordinary synchronous handlers are qualified');
    const declared=scopes.get(node.id)??[];
    require(ctx,node.handlers.length<=declared.length&&node.handlers.length<=64,'handler appeared without its source entry');
    const current=[];
    for(let index=0;index<node.handlers.length;index++){
      const handler=node.handlers[index],entry=declared[index];
      require(ctx,Object.keys(handler).every(key=>handlerFields.includes(key))&&
        staticFields.every(key=>handler[key]===entry.definition[key]),'retained handler targets or scope changed');
      require(ctx,['try','catch','finally'].includes(handler.phase)&&
        (handler.phase!=='catch'||handler.catchPc!==null)&&(handler.phase!=='finally'||handler.finallyPc!==null),
        'handler phase lacks its source capability');
      const caught=handler.caught?.value??null,pending=completion(ctx,handler.pending,event);
      require(ctx,(caught===null||handler.phase==='catch')&&(handler.phase==='finally'?pending!==null:pending===null),
        'pending completion or caught value has the wrong handler phase');
      if(caught!==null)require(ctx,caught[0]!=='symbol','Symbol catch requires a protocol transfer');
      current.push({...entry,public:{id:entry.id,catch:handler.catchPc!==null,finally:handler.finallyPc!==null,
        phase:handler.phase,caught:caught===null?null:ctx.tag(caught,event),pending}});
    }
    scopes.set(node.id,current);
  }
  function publicScopes(ctx){
    const rows=[];
    for(const invocation of ctx.controller.stack)for(const [owned,entries]of scopes){
      if(ctx.frame(owned)===invocation&&entries.length)rows.push({invocation,handlers:entries.map(entry=>ctx.copy(entry.public))});
    }
    return {schema,frames:rows};
  }
  return {id:COMPLETION_SOURCE_PROFILE_V8,
    setup(ctx){ctx.extensionState.set(COMPLETION_SOURCE_PROFILE_V8,true);},
    frameFields(node){
      if(node.generatorId)return null;
      if(node.handlers?.length||tracked.has(node.id)){tracked.add(node.id);return [];}
      return null;
    },
    event(ctx,event){
      const current=ctx.getOwnedFrame(event.invocationId);
      if(!current||current.generatorId)return false;
      const inst=instruction(ctx,event);
      if(inst?.op==='TRY_ENTER'){
        const after=event.stateChanges.find(row=>row.table==='frames'&&row.id===current.id)?.after,
          handler=after?.handlers?.at(-1),entries=scopes.get(current.id)??[];
        require(ctx,handler&&after.handlers.length===current.handlers.length+1&&entries.length===current.handlers.length&&
          handler.catchPc===inst.arg.catchPc&&handler.finallyPc===inst.arg.finallyPc&&handler.afterPc===inst.arg.afterPc,
          'handler entry differs from its exact source declaration');
        scopes.set(current.id,[...entries,{id:'handler'+(++sequence),definition:Object.fromEntries(staticFields.map(key=>[key,handler[key]]))}]);
        return true;
      }
      if(inst?.op==='BIND_CATCH'){
        const handler=current.handlers.at(-1),after=event.stateChanges.find(row=>row.table==='frames'&&row.id===current.id)?.after;
        require(ctx,handler?.phase==='catch'&&handler.caught?.value,'catch binding lacks the exact thrown value');
        if(inst.arg!==null){
          const environment=event.stateChanges.find(row=>row.table==='envs'&&row.id===after?.envId)?.after,
            binding=environment?.bindings?.[inst.arg];
          require(ctx,binding?.kind==='catch'&&binding.initialized&&ctx.eq(binding.token?.value,handler.caught.value),
            'catch binding changed the thrown value');
          ctx.bind(ctx.cell(environment.id,inst.arg),binding.token.value,event);
        }
        return true;
      }
      if(inst?.op==='TRY_NORMAL'){
        require(ctx,current.handlers.at(-1)&&current.handlers.at(-1).phase!=='finally','normal completion lacks its active handler');
        return true;
      }
      if(inst?.op==='END_FINALLY'){
        require(ctx,current.handlers.at(-1)?.phase==='finally'&&current.handlers.at(-1).pending,
          'cleanup lost its pending completion');
        return true;
      }
      return false;
    },
    afterEvent(ctx,event){
      for(const change of event.stateChanges)if(change.table==='frames'&&change.after)update(ctx,change.after,event);
      if(!ctx.controller.stack.length)return;
      const next=publicScopes(ctx),previous=ctx.controller.pending?.handler;
      if(!next.frames.length&&previous?.schema!==schema)return;
      if(ctx.eq(next,previous))return;
      ctx.emit({kind:'transfer',fields:{kind:'cleanup',value:U,handler:next}},event,'owned-source-handler-scope/1',{detail:true});
    },
    checkFrame(ctx,node,event){
      update(ctx,node,event);
      if(ctx.controller.stack.includes(ctx.frame(node.id))&&(scopes.get(node.id)?.length||ctx.controller.pending?.handler?.schema===schema))
        require(ctx,ctx.eq(ctx.controller.pending?.handler,publicScopes(ctx)),'public cleanup obligations differ from source handlers');
      return true;
    }
  };
}
