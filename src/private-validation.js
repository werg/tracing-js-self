// Independent, read-only evidence that private storage is separate from public
// properties and can only change through its owning lexical private name.
import {decode,encode} from './values.js';
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fields=['privateSlots','privateKinds','privateVersions'];
export function validatePrivateEvent(state,event,programs,fail){
  const frame=state.frames[event.invocationId],instruction=programs[frame?.codeId]?.instructions[frame?.pc];
  const op=instruction?.op,privateOperation=op?.startsWith('PRIVATE_');
  const changed=event.stateChanges.filter(p=>p.table==='heap'&&fields.some(key=>!eq(p.before?.[key],p.after?.[key])));
  if(!privateOperation){
    if(changed.length)fail('Private storage changed without a private operation');
    return;
  }
  let environment=frame.envId;
  const name='[[private '+instruction.arg.name+']]';
  while(environment&&!Object.hasOwn(state.envs[environment]?.bindings??{},name))environment=state.envs[environment]?.parent;
  const binding=state.envs[environment]?.bindings?.[name],brand=binding?.token?.value?.[1];
  if(!binding?.initialized||binding.kind!=='const'||binding.token.value[0]!=='str'||!/^private:o\d+:\d+$/.test(brand))
    fail('Private operation lacks its lexical identity');
  const writes=['PRIVATE_DEFINE','PRIVATE_SET'].includes(op),base=frame.stack.at(writes?-2:-1)?.value;
  const object=base?.[0]==='ref'?state.heap[base[1]]:null;
  const present=Object.hasOwn(object?.privateSlots??{},brand);
  const expectedFault=op==='PRIVATE_HAS'?!object&&!['promise','intrinsic','builtinfn','hostfn'].includes(base?.[0]):
    !object||op==='PRIVATE_DEFINE'?(!object||present):!present||['PRIVATE_SET','PRIVATE_UPDATE'].includes(op)&&object.privateKinds[brand]!=='field';
  if(expectedFault){
    if(event.completion?.type!=='throw'||event.completion.errorType!=='TypeError'||changed.length)
      fail('Invalid private brand or readonly failure');
    return;
  }
  if(event.completion?.type==='throw')fail('Unexpected private operation throw');
  const old=object?.privateSlots?.[brand];
  let result;
  if(op==='PRIVATE_HAS')result=['bool',present];
  else if(op==='PRIVATE_GET')result=old.value;
  else if(op==='PRIVATE_GET_METHOD')result=['method',old.value,base];
  else{
    let stored=frame.stack.at(-1).value;
    if(op==='PRIVATE_UPDATE'){
      if(!['undefined','null','bool','str','num','bigint'].includes(old.value[0]))return;
      const numeric=old.value[0]==='bigint'?decode(old.value):Number(decode(old.value));
      const delta=instruction.arg.operator==='++'?1:-1;
      stored=encode(numeric+(typeof numeric==='bigint'?BigInt(delta):delta));
      result=instruction.arg.prefix?stored:encode(numeric);
    }else result=stored;
    if(changed.length!==1||changed[0].id!==object.id)fail('Private write changed a different identity');
    const after=changed[0].after;
    const expectedSlots={...object.privateSlots,[brand]:{value:stored,origin:event.eventId}};
    const expectedKinds={...object.privateKinds,[brand]:op==='PRIVATE_DEFINE'?instruction.arg.kind:object.privateKinds[brand]};
    const expectedVersions={...object.privateVersions,[brand]:(object.privateVersions?.[brand]??0)+1};
    if(!eq(after.privateSlots,expectedSlots)||!eq(after.privateKinds,expectedKinds)||!eq(after.privateVersions,expectedVersions)||
       !eq(after.properties,object.properties)||!eq(after.accessors,object.accessors))
      fail('Private write did not preserve its separate owned slot');
  }
  if(!eq(event.result,result))fail('Private completion disagrees with committed storage');
  if(['PRIVATE_GET','PRIVATE_GET_METHOD','PRIVATE_HAS'].includes(op)&&changed.length)
    fail('Private read mutated storage');
}
