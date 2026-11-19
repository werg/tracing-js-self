// Frozen template objects are realm/source-site state, not fresh call arguments.
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const publicFields=['kind','properties','propertyVersions','propertyOrder','dataAttributes','accessors','extensible','prototype','templateSite','templateRawOf'];
export function validateTemplateEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const caches=event.stateChanges.filter(p=>p.table==='control'&&!eq(p.before?.templateObjects,p.after?.templateObjects));
  for(const patch of event.stateChanges)if(patch.table==='heap'&&(patch.before?.templateSite||patch.before?.templateRawOf)){
    if(!patch.after||publicFields.some(field=>!eq(patch.before[field],patch.after[field])))
      fail('Frozen template storage was mutated');
  }
  if(instruction?.op!=='GET_TEMPLATE_OBJECT'){
    if(caches.length||event.stateChanges.some(p=>p.table==='heap'&&p.before===null&&(p.after?.templateSite||p.after?.templateRawOf)))
      fail('Template identity created outside its source operation');
    return;
  }
  const site=instruction.siteId,known=state.control.a0.templateObjects?.[site];
  if(known){
    if(!eq(event.result,['ref',known])||caches.length)fail('Repeated template site changed identity');
    return;
  }
  const allocated=event.stateChanges.filter(p=>p.table==='heap'&&p.before===null).map(p=>p.after);
  const cooked=allocated.find(x=>x.templateSite===site),raw=allocated.find(x=>x.templateRawOf===site);
  if(allocated.length!==2||!cooked||!raw||caches.length!==1||
     !eq(event.result,['ref',cooked.id])||
     !eq(caches[0].after.templateObjects,{...state.control.a0.templateObjects,[site]:cooked.id}))
    fail('Template site lacks its unique cooked/raw pair');
  for(const [object,values,hasRaw] of [[cooked,instruction.arg.cooked,true],[raw,instruction.arg.raw.map(x=>['str',x]),false]]){
    const keys=[...values.map((_,i)=>String(i)),'length',...(hasRaw?['raw']:[])];
    if(object.kind!=='array'||object.extensible!==false||Object.keys(object.properties).length!==keys.length||
       !eq(object.properties.length?.value,['num',values.length])||
       hasRaw&&!eq(object.properties.raw?.value,['ref',raw.id]))fail('Invalid template array shape');
    for(const key of keys){
      const slot=object.properties[key],attributes=object.dataAttributes?.[key];
      if(!slot||slot.origin!==event.eventId||!eq(attributes,{enumerable:key!=='length'&&key!=='raw',writable:false,configurable:false})||
         /^\d+$/.test(key)&&!eq(slot.value,values[Number(key)]))fail('Invalid frozen template descriptor or string');
    }
  }
}
