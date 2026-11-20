// Ordinary custom for-of uses the same checked properties, calls and cleanup
// scopes as explicit source. Only source-internal method caching and guards
// need adaptation; they never install a second callback or unwind machine.
import {parse} from 'acorn';
export const CUSTOM_ITERATOR_SOURCE_PROFILE_V8='custom-iterator-source/1';
const cached=/^\[\[iterator next [0-9]+\]\]$/;
export function createCustomIteratorSourceAdapterV8({bundle,source}){
  if(!Object.values(bundle.programs).some(program=>program.instructions.some(row=>row.op==='ITERATOR_ARRAY_GUARD')))return null;
  const patterns=new Set(),defaults=new Set(),rests=new Set();
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='VariableDeclarator'&&node.init&&node.id.type==='ArrayPattern'&&node.id.elements.every(element=>element===null||
      element.type==='Identifier'||element.type==='AssignmentPattern'&&element.left.type==='Identifier'||
      element.type==='RestElement'&&element.argument.type==='Identifier')){
      patterns.add(node.id.start+':'+node.id.end);
      for(const element of node.id.elements)if(element?.type==='AssignmentPattern')defaults.add(element.start+':'+element.end);
      else if(element?.type==='RestElement')rests.add(element.start+':'+element.end);
    }
    for(const [key,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(key))visit(value);
  }visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  const methods=new Map();
  const require=(ctx,condition,message)=>{if(!condition)ctx.refuse('custom iterator: '+message);};
  return {id:CUSTOM_ITERATOR_SOURCE_PROFILE_V8,
    setup(ctx){ctx.extensionState.set(CUSTOM_ITERATOR_SOURCE_PROFILE_V8,{patterns,defaults,rests});},
    event(ctx,event){
      const frame=ctx.getOwnedFrame(event.invocationId),inst=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
      if(!inst||inst.siteId!==event.siteId)return false;
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
      if((node?.type!=='ForOfStatement'||node.await)&&!pattern)return false;
      if(inst.op==='REQUIRE_OBJECT'){
        require(ctx,event.operands.length===1&&event.result?.[0]==='ref'&&ctx.eq(event.result,event.operands[0])&&
          ctx.controller.heap.has(event.result[1]),'iterator call must return its already published object');
        return true;
      }
      if(inst.op==='INIT'&&(cached.test(inst.arg)||pattern&&event.result?.[0]==='method')){
        require(ctx,!frame.generatorId&&!frame.asyncPromiseId,'only ordinary synchronous loop cleanup is qualified');
        const method=event.result,environment=event.stateChanges.find(row=>row.table==='envs'&&row.after?.bindings?.[inst.arg]?.initialized)?.after;
        require(ctx,method?.length===3&&method[0]==='method'&&method[1]?.[0]==='ref'&&method[2]?.[0]==='ref'&&environment&&
          ['object','array'].includes(ctx.state.heap[method[2][1]]?.kind)&&ctx.state.heap[method[1][1]]?.kind==='function',
          'cached next requires an ordinary object and source callable');
        const key=environment.id+':'+inst.arg;
        require(ctx,!methods.has(key),'next was cached more than once');
        const entry={method:ctx.copy(method),callee:ctx.cell(environment.id,inst.arg),receiver:ctx.cell(environment.id,inst.arg+' receiver')};
        ctx.bind(entry.callee,method[1],event);ctx.bind(entry.receiver,method[2],event);methods.set(key,entry);
        return true;
      }
      if(inst.op==='GET'&&(cached.test(inst.arg)||pattern&&event.result?.[0]==='method')){
        const read=event.readObservations.find(row=>row.kind==='binding'&&row.name===inst.arg),entry=methods.get(read?.envId+':'+inst.arg);
        require(ctx,entry&&ctx.eq(event.result,entry.method)&&ctx.eq(ctx.controller.locals.get(entry.callee),entry.method[1])&&
          ctx.eq(ctx.controller.locals.get(entry.receiver),entry.method[2]),'cached next or its receiver changed');
        return true;
      }
      if(inst.op==='LOGICAL_JUMP'){
        const method=event.operands[0],selected=method?.[1],present=!['null','undefined'].includes(selected?.[0]);
        require(ctx,inst.arg.operator==='??'&&method?.length===3&&method[0]==='method'&&method[2]?.[0]==='ref'&&
          ctx.eq(event.result,['bool',present]),'close method guard differs from its selected method');
        ctx.emit({kind:'choose',expr:{op:'logical-test',operator:'??',arg:{op:'literal',value:ctx.tag(selected,event)}},
          decision:event.result,path:present?'use-left':'evaluate-right'},event,'source-iterator-return-selection/1');
        return true;
      }
      if(inst.op==='PENDING_THROW'){
        const owned=frame.handlers.findLast(handler=>handler.phase==='finally'),
          retained=ctx.controller.pending?.handler?.frames?.find(row=>row.invocation===ctx.frame(frame.id))?.handlers.findLast(handler=>handler.phase==='finally');
        require(ctx,owned?.pending&&retained?.pending&&ctx.eq(event.result,['bool',owned.pending.type==='throw'])&&
          (owned.pending.type==='throw')===(retained.pending.kind==='throw'),'close lost the pending throw precedence');
        return true;
      }
      return false;
    }
  };
}
