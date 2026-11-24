// Source adapter for explicit builtin iterator calls. Public cursor state is
// derived by the evaluator and compared after every owned heap transition.
const id='builtin-iterator/1';
const fields=['iterated','nextIndex','done','iterationKind','properties','propertyVersions','shapeVersion'];
const factories=new Map([['Array.prototype.values','values'],['Array.prototype.keys','keys'],
  ['Array.prototype.entries','entries'],['String.prototype.iterator','string'],
  ['Set.prototype.values','set-values'],['Set.prototype.entries','set-entries'],
  ['Map.prototype.keys','map-keys'],['Map.prototype.values','map-values'],['Map.prototype.entries','map-entries']]);
const builtinNames=new Set([...factories.keys(),'Iterator.next','Iterator.identity']);
function instruction(ctx,event){const frame=ctx.getOwnedFrame(event.invocationId);
  return ctx.bundle.programs[frame?.codeId]?.instructions[frame.pc];}
export function createIteratorSourceAdapterV8(){let arrayLoops=new Set();return {
  id,
  captureState:()=>({arrayLoops:[...arrayLoops]}),
  restoreState(state){arrayLoops=new Set(state.arrayLoops);},
  heapFields(node){return node.kind==='iterator'?fields:null;},
  checkHeap(ctx,node){
    if(node.kind!=='iterator')return true;
    if(Object.keys(node.properties??{}).length||Object.keys(node.propertyVersions??{}).length||node.shapeVersion!==0)
      ctx.refuse('builtin iterator own properties require a separate profile');
    return ctx.eq(ctx.controller.heap.get(node.id),{kind:'iterator',iterated:node.iterated,iterationKind:node.iterationKind,
      nextIndex:node.nextIndex,done:node.done,properties:new Map()});
  },
  allocate(ctx,node){if(node.kind==='iterator')ctx.refuse('iterator allocation must follow its exact builtin call');return false;},
  event(ctx,event,row){
    if(instruction(ctx,event)?.op==='ITERATOR_ARRAY_GUARD'){
      if(event.result?.[0]!=='bool')ctx.refuse('iterator selection guard must be boolean');
      const source=ctx.bundle.sites.find(site=>site.siteId===event.siteId),node=ctx.inventory.nodes.get(source?.start+':'+source?.end);
      const custom=ctx.extensionState.get('custom-iterator-source/1'),point=source?.start+':'+source?.end,
        pattern=node?.type==='ArrayPattern'&&custom?.patterns.has(point),nested=pattern&&custom?.nestedPatterns?.has(point);
      if((node?.type!=='ForOfStatement'||node.await)&&!pattern)ctx.refuse('array iteration guard lacks its qualified synchronous loop or binding pattern');
      if(nested&&!event.result[1])ctx.refuse('nested custom iterable binding requires an independently scoped iterator observer');
      ctx.emit({kind:'iterator.arrayGuard',iterated:ctx.tag(event.operands[0],event),result:event.result[1]},event,'source-iterator-array-selection/1');
      if(event.result[1])arrayLoops.add(event.invocationId+':'+source.start+':'+source.end);
      return true;
    }
    if(!row)return false;
    const inst=instruction(ctx,event);
    if(inst?.op==='SPREAD'&&event.operation==='property.read'){
      const snapshot=row.result;
      if(snapshot?.[0]!=='spread'||!Array.isArray(snapshot[1]))ctx.refuse('spread lacks its bounded iterable snapshot');
      const iterated=ctx.tag(row.operands[0],event),values=snapshot[1].map(value=>ctx.tag(value,event));
      ctx.emit({kind:'iterator.spread',iterated,values},event,'source-builtin-iterator-spread/1');return true;
    }
    if(inst?.op==='APPEND_ARRAY'&&event.operation==='property.write'){
      const base=row.operands[0],input=row.operands[1],spread=inst.arg.spread===true,
        values=spread&&input?.[0]==='spread'?input[1]:spread?null:[input],
        before=base?.[0]==='ref'?ctx.state.heap[base[1]]:null,
        after=event.stateChanges.find(change=>change.table==='heap'&&change.id===base?.[1])?.after??before,
        rawLength=before?.properties?.length?.value,start=rawLength?.[0]==='num'?rawLength[1]:NaN,
        hole=inst.arg.hole===true,count=hole?0:values?.length;
      if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||start+count+(hole?1:0)>10000||
        before?.kind!=='array'||after?.kind!=='array'||!ctx.eq(event.result,base))
        ctx.refuse('array literal append is outside its bounded result profile');
      const afterLength=after.properties.length?.value,expectedLength=start+count+(hole?1:0);
      if(afterLength?.[0]!=='num'||afterLength[1]!==expectedLength)
        ctx.refuse('array literal append changed an unexpected length');
      if(hole){
        if(Object.hasOwn(after.properties,String(start)))ctx.refuse('array literal hole acquired an indexed value');
        ctx.emit({kind:'property.set',object:base[1],key:['str','length'],receiver:ctx.tag(base,event),
          value:['num',expectedLength],success:true},event,'source-array-literal-hole/1');
      }else{
        for(let index=0;index<count;index++){
          const descriptor=after.properties[String(start+index)];
          if(!descriptor||!ctx.eq(descriptor.value,values[index])||after.accessors?.[String(start+index)])
            ctx.refuse('array literal append output differs from its evaluated item');
          ctx.emit({kind:'property.set',object:base[1],key:['str',String(start+index)],receiver:ctx.tag(base,event),
            value:ctx.tag(values[index],event),success:true},event,spread?'source-array-literal-spread-element/1':'source-array-literal-element/1');
        }
      }
      return true;
    }
    if(event.operation==='primitive.binary'&&inst?.op==='BINARY'&&inst.arg==='>'&&
      arrayLoops.has(event.invocationId+':'+row.source?.start+':'+row.source?.end)){
      if(row.operands.length!==2||row.operands.some(value=>value[0]!=='num'))ctx.refuse('array loop comparison requires numeric length and index');
      ctx.emit({kind:'compute',fields:{expr:{op:'binary',operator:'>',left:{op:'literal',value:row.operands[0]},
        right:{op:'literal',value:row.operands[1]}},result:row.result}},event,'source-standard-array-loop-test/1',{detail:true});return true;
    }
    if(event.operation==='property.read'&&!row.child){
      const output=row.result?.[0]==='method'?row.result[1]:row.result;
      if(output?.[0]==='builtinfn'&&builtinNames.has(output[1])){
        ctx.emit({kind:'iterator.lookup',receiver:ctx.tag(row.operands[0],event),key:ctx.key(row.operands[1]),method:output[1]},event,'source-iterator-builtin-lookup/1');return true;
      }
      const node=row.operands[0]?.[0]==='ref'?ctx.state.heap[row.operands[0][1]]:null;
      if(node?.kind==='iterator'){
        ctx.emit({kind:'iterator.read',object:node.id,key:ctx.key(row.operands[1]),result:ctx.tag(output,event)},event,'source-iterator-property/1');return true;
      }
    }
    if(event.operation!=='call.enter'||row.child)return false;
    const method=row.operands[0],callee=method?.[0]==='method'?method[1]:method;
    if(callee?.[0]!=='builtinfn'||!builtinNames.has(callee[1]))return false;
    if(method[0]!=='method')ctx.refuse('captured iterator builtin calls require an explicit callable value profile');
    const receiver=ctx.tag(method[2],event),changes=event.stateChanges.filter(change=>change.table==='heap');
    for(const argument of row.operands.slice(1))ctx.tag(argument,event);
    if(factories.has(callee[1])){
      const node=changes.find(change=>change.before===null&&change.id===row.result?.[1])?.after;
      if(row.result?.[0]!=='ref'||node?.kind!=='iterator'||changes.length!==1)ctx.refuse('iterator factory has undeclared allocations');
      ctx.emit({kind:'iterator.create',name:node.id,iterated:receiver,iterationKind:factories.get(callee[1])},event,'source-iterator-create/1');
      ctx.markPublished(node.id);return true;
    }
    if(receiver[0]!=='ref')ctx.refuse('iterator method has no owned receiver');
    if(callee[1]==='Iterator.identity'){
      if(changes.length)ctx.refuse('iterator identity changed owned heap state');
      ctx.emit({kind:'iterator.identity',object:receiver[1],result:ctx.tag(row.result,event)},event,'source-iterator-identity/1');return true;
    }
    const iterator=ctx.state.heap[receiver[1]],result=changes.find(change=>change.id===row.result?.[1]&&change.before===null)?.after;
    if(iterator?.kind!=='iterator'||row.result?.[0]!=='ref'||result?.kind!=='object'||result.properties.done?.value[0]!=='bool')
      ctx.refuse('iterator step lacks its exact result object');
    const done=result.properties.done.value[1],value=result.properties.value?.value;
    if(!value)ctx.refuse('iterator result lacks a value slot');
    const entryKind=iterator.iterationKind==='entries'||iterator.iterationKind.endsWith('-entries'),
      pair=!done&&entryKind?changes.find(change=>change.id===value[1]&&change.before===null)?.after:null;
    if(!done&&entryKind&&(value[0]!=='ref'||pair?.kind!=='array'))ctx.refuse('iterator entry pair allocation missing');
    const allowed=new Set([receiver[1],result.id,...(pair?[pair.id]:[])]);
    if(changes.some(change=>!allowed.has(change.id)))ctx.refuse('iterator next has an undeclared heap effect');
    ctx.emit({kind:'iterator.next',object:receiver[1],name:result.id,entry:pair?.id??null,
      result:value[0]==='promise'?ctx.tag(value,event):ctx.copy(value),done},event,'source-iterator-next/1');
    if(pair)ctx.markPublished(pair.id);ctx.markPublished(result.id);return true;
  }
};}
