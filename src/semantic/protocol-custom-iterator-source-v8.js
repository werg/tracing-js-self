// Ordinary custom for-of uses the same checked properties, calls and cleanup
// scopes as explicit source. Only source-internal method caching and guards
// need adaptation; they never install a second callback or unwind machine.
import {parse} from 'acorn';
import {stringPropertyKey,symbolPropertyKey} from '../property-keys.js';
export const CUSTOM_ITERATOR_SOURCE_PROFILE_V8='custom-iterator-source/1';
const cached=/^\[\[(?:(?:async|sync) )?iterator next [0-9]+\]\]$/;
export function createCustomIteratorSourceAdapterV8({bundle,source}){
  const patterns=new Set(),nestedPatterns=new Set(),defaults=new Set(),rests=new Set();let asyncLoop=false;
  const supported=pattern=>pattern?.type==='Identifier'||pattern?.type==='ArrayPattern'&&pattern.elements.every(element=>element===null||supported(element))||
    pattern?.type==='AssignmentPattern'&&supported(pattern.left)||pattern?.type==='RestElement'&&supported(pattern.argument);
  function collect(pattern,root=true){
    if(pattern.type==='ArrayPattern'){const point=pattern.start+':'+pattern.end;patterns.add(point);if(!root)nestedPatterns.add(point);
      pattern.elements.forEach(element=>{if(element)collect(element,false);});}
    else if(pattern.type==='AssignmentPattern'){defaults.add(pattern.start+':'+pattern.end);collect(pattern.left,false);}
    else if(pattern.type==='RestElement'){rests.add(pattern.start+':'+pattern.end);collect(pattern.argument,false);}
  }
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='ForOfStatement'&&node.await)asyncLoop=true;
    // Variable binding patterns share the retained iterator machinery. Every
    // nested pattern keeps its own source range for guard/default/rest claims.
    if(node.type==='VariableDeclarator'&&node.id.type==='ArrayPattern'&&supported(node.id))collect(node.id);
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  if(!asyncLoop&&!Object.values(bundle.programs).some(program=>program.instructions.some(row=>row.op==='ITERATOR_ARRAY_GUARD')))return null;
  let methods=new Map(),accessors=new Map(),accessorSequence=0;
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('custom iterator: '+message);};
  return {id:CUSTOM_ITERATOR_SOURCE_PROFILE_V8,
    captureState:()=>({methods:[...methods],patterns:[...patterns],nestedPatterns:[...nestedPatterns],defaults:[...defaults],rests:[...rests],
      asyncLoop,accessors:[...accessors],accessorSequence}),
    restoreState(state){methods=new Map(state.methods);accessors=new Map(state.accessors);accessorSequence=state.accessorSequence;},
    setup(ctx){ctx.extensionState.set(CUSTOM_ITERATOR_SOURCE_PROFILE_V8,{patterns,nestedPatterns,defaults,rests});},
    event(ctx,event,row){
      const frame=ctx.getOwnedFrame(event.invocationId),inst=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
      if(!inst||inst.siteId!==event.siteId)return false;
      const base=event.operands[0],baseNode=base?.[0]==='ref'?ctx.state.heap[base[1]]:null,
        output=event.result?.[0]==='method'?event.result[1]:event.result;
      if(asyncLoop&&event.operands.length>=2&&['object','array','function'].includes(baseNode?.kind)&&
        (event.operation==='property.write'&&inst.op!=='APPEND_ARRAY'||
          event.operation==='property.read'&&!['builtinfn','intrinsic'].includes(output?.[0]))){
        const key=ctx.key(event.operands[1]),receiver=ctx.tag(base,event);
        if(row?.child){
          const operation=event.operation==='property.read'?'get':'set',id='iteratoraccess'+(++accessorSequence),
            child=ctx.frame(row.child),value=operation==='set'?ctx.tag(event.operands[2],event):null;
          ctx.emit({kind:'property.'+operation+'.call',id,child,object:base[1],key,receiver,
            ...(operation==='set'?{value}:{})},event,'source-async-iterator-accessor-call/1');
          accessors.set(row.child,{id,operation,value});
          const changed=event.stateChanges.find(change=>change.table==='frames'&&change.id===row.child)?.after,
            environment=event.stateChanges.find(change=>change.table==='envs'&&change.id===changed?.envId)?.after;
          for(const [name,binding]of Object.entries(environment?.bindings??{}))if(binding.initialized)
            ctx.bind(ctx.cell(environment.id,name),binding.token.value,event);
        }else if(event.operation==='property.read')
          ctx.emit({kind:'property.get',object:base[1],key,receiver,result:ctx.tag(output,event)},event,'source-async-iterator-property-read/1');
        else if(inst.op==='DEFINE_LITERAL_PROP'){
          require(ctx,inst.arg.kind!=='prototype','custom prototypes require their own source protocol');
          const node=event.stateChanges.find(change=>change.table==='heap'&&change.id===base[1])?.after,
            storage=key[0]==='str'?stringPropertyKey(key[1]):symbolPropertyKey(key[1]),descriptor=ctx.descriptor(node,storage);
          if(descriptor.kind==='data')descriptor.value=ctx.tag(descriptor.value,event);
          else{descriptor.get=ctx.tag(descriptor.get,event);descriptor.set=ctx.tag(descriptor.set,event);}
          ctx.emit({kind:'property.define',object:base[1],key,descriptor,success:true},event,'source-async-iterator-property-definition/1');
        }else ctx.emit({kind:'property.set',object:base[1],key,receiver,value:ctx.tag(event.operands[2],event),success:true},
          event,'source-async-iterator-property-write/1');
        return true;
      }
      const site=ctx.bundle.sites.find(row=>row.siteId===event.siteId),node=ctx.inventory.nodes.get(site?.start+':'+site?.end);
      const point=site?.start+':'+site?.end,pattern=node?.type==='ArrayPattern'&&patterns.has(point);
      if(defaults.has(point)&&inst.op==='BINARY'){
        require(ctx,inst.arg==='==='&&event.operands.length===2&&ctx.eq(event.operands[1],['undefined']),
          'binding default differs from its undefined-value guard');
        ctx.emit({kind:'compute',fields:{expr:{op:'binary',operator:'===',left:{op:'literal',value:ctx.tag(event.operands[0],event)},
          right:{op:'literal',value:['undefined']}},result:event.result}},event,'source-iterator-binding-default/1',{detail:true});return true;
      }
      if(rests.has(point)&&inst.op==='APPEND_ARRAY'){
        const object=event.operands[0],value=event.operands[1],array=object?.[0]==='ref'?ctx.controller.heap.get(object[1]):null,
          length=array?.properties.get('length');
        require(ctx,inst.arg.spread===false&&array?.kind==='array'&&length?.[0]==='num'&&Number.isSafeInteger(length[1]),
          'rest binding requires an ordinary bounded array append');
        ctx.emit({kind:'property.set',object:object[1],key:['str',String(length[1])],receiver:ctx.tag(object,event),
          value:ctx.tag(value,event),success:true},event,'source-iterator-rest-element/1');return true;
      }
      if(node?.type!=='ForOfStatement'&&!pattern)return false;
      if(node?.await&&inst.op==='UNARY'){
        require(ctx,inst.arg==='!'&&event.operands.length===1,'iterator completion coercion differs');
        ctx.emit({kind:'compute',expr:{op:'unary',operator:'!',arg:{op:'literal',value:ctx.tag(event.operands[0],event)}},
          result:ctx.tag(event.result,event),bind:null},event,'source-async-iterator-completion-coercion/1');return true;
      }
      if(inst.op==='REQUIRE_OBJECT'){
        require(ctx,event.operands.length===1&&event.result?.[0]==='ref'&&ctx.eq(event.result,event.operands[0])&&
          ctx.controller.heap.has(event.result[1]),'iterator call must return its already published object');
        return true;
      }
      if(inst.op==='INIT'&&(cached.test(inst.arg)||pattern)&&event.result?.[0]==='method'){
        require(ctx,!frame.generatorId||ctx.bundle.programs[frame.codeId]?.generator===true,
          'an unqualified generator frame is not supported');
        const method=event.result,environment=event.stateChanges.find(row=>row.table==='envs'&&row.after?.bindings?.[inst.arg]?.initialized)?.after;
        const builtin=ctx.eq(method?.[1],['builtinfn','Iterator.next'])&&ctx.state.heap[method?.[2]?.[1]]?.kind==='iterator';
        require(ctx,method?.length===3&&method[0]==='method'&&method[2]?.[0]==='ref'&&environment&&(builtin||
          method[1]?.[0]==='ref'&&['object','array'].includes(ctx.state.heap[method[2][1]]?.kind)&&ctx.state.heap[method[1][1]]?.kind==='function'),
          'cached next requires an ordinary object and source callable');
        const key=environment.id+':'+inst.arg;
        require(ctx,!methods.has(key),'next was cached more than once');
        const entry={method:ctx.copy(method),callee:ctx.cell(environment.id,inst.arg),receiver:ctx.cell(environment.id,inst.arg+' receiver'),
          value:builtin?['str','Iterator.next']:ctx.copy(method[1])};
        if(builtin)ctx.bindDerived(entry.callee,entry.value,event);else ctx.bind(entry.callee,method[1],event);
        ctx.bind(entry.receiver,method[2],event);methods.set(key,entry);
        return true;
      }
      if(inst.op==='GET'&&(cached.test(inst.arg)||pattern)&&event.result?.[0]==='method'){
        const read=event.readObservations.find(row=>row.kind==='binding'&&row.name===inst.arg),entry=methods.get(read?.envId+':'+inst.arg);
        require(ctx,entry&&ctx.eq(event.result,entry.method)&&ctx.eq(ctx.controller.locals.get(entry.callee),entry.value)&&
          ctx.eq(ctx.controller.locals.get(entry.receiver),entry.method[2]),'cached next or its receiver changed');
        return true;
      }
      if(inst.op==='LOGICAL_JUMP'){
        const method=event.operands[0],selected=method?.[0]==='method'?method[1]:method,
          helper=method?.[0]==='ref'&&bundle.programs[ctx.state.heap[method[1]]?.codeId]?.sourceRole==='async-from-sync-return',
          present=!['null','undefined'].includes(selected?.[0]);
        require(ctx,inst.arg.operator==='??'&&(helper||method?.length===3&&method[0]==='method'&&['ref','str'].includes(method[2]?.[0]))&&
          ctx.eq(event.result,['bool',present]),'close method guard differs from its selected method');
        ctx.emit({kind:'choose',expr:{op:'logical-test',operator:'??',arg:{op:'literal',value:ctx.tag(selected,event)}},
          decision:event.result,path:present?'use-left':'evaluate-right'},event,'source-iterator-return-selection/1');
        return true;
      }
      if(inst.op==='PENDING_THROW'){
        const owned=frame.handlers.findLast(handler=>handler.phase==='finally'),
          retained=frame.generatorId?ctx.controller.heap.get(frame.generatorId)?.handlers.findLast(handler=>handler.phase==='finally'):
            ctx.controller.pending?.handler?.frames?.find(row=>row.invocation===ctx.frame(frame.id))?.handlers.findLast(handler=>handler.phase==='finally');
        require(ctx,Boolean(owned)===Boolean(retained)&&(!owned?ctx.eq(event.result,['bool',false]):owned.pending&&retained.pending&&
          ctx.eq(event.result,['bool',owned.pending.type==='throw'])&&
          (owned.pending.type==='throw')===(retained.pending.kind==='throw')),'close lost the pending throw precedence');
        return true;
      }
      return false;
    },
    completeFrame(ctx,change,event){
      const pending=accessors.get(change.id),completion=change.after?.completion;
      require(ctx,pending&&['return','throw'].includes(completion?.type),'accessor lost its exact completion');
      const value=ctx.tag(completion.value.value,event),invocation=ctx.frame(change.id);
      ctx.emit({kind:completion.type,invocation,value},event,'source-async-iterator-accessor-return/1');
      ctx.emit({kind:'property.finish',id:pending.id,completion:{kind:completion.type==='throw'?'throw':'normal',
        value:completion.type==='throw'||pending.operation==='get'?value:pending.value}},event,'source-async-iterator-accessor-finish/1');
      accessors.delete(change.id);return true;
    },
    afterEvent(ctx,event){
      if(!asyncLoop)return;
      for(const change of event.stateChanges)if(change.table==='heap'&&change.after&&
        ['object','array'].includes(change.after.kind)&&ctx.controller.heap.has(change.id))ctx.baseCheckHeap(change.after);
    }
  };
}
