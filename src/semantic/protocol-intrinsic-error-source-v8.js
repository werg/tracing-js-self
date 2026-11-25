// Authenticate an implicit in-operator failure from its current source frame.
// Both source coordinators call this same teacher check; the public machine
// independently derives the fault from the two operands.
import {isDeepStrictEqual as eq} from 'node:util';
import {parse} from 'acorn';
import {invalidInMessage} from '../intrinsic-error-diagnostics.js';
export function sourceInvalidInFaultV8(bundle,state,event,row){
  const before=state.frames[event.invocationId],instruction=bundle.programs[before?.codeId]?.instructions[before?.pc],
    operands=before?.stack?.slice(-2)??[],key=operands[0]?.value,target=operands[1]?.value,
    source=bundle.sources.find(source=>source.sourceId===bundle.entrySpec.sourceId)?.text;
  let site=false;
  function visit(node){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach(visit);return;}
    if(node.type==='BinaryExpression'&&node.operator==='in'&&node.start===instruction?.start&&node.end===instruction?.end)site=true;
    for(const [name,value]of Object.entries(node))if(!['start','end','loc','raw'].includes(name))visit(value);
  }
  if(typeof source==='string')visit(parse(source,{ecmaVersion:'latest',sourceType:'script'}));
  const changes=event.stateChanges.filter(change=>change.table==='heap'),change=changes[0],error=change?.after,
    message=key&&target?invalidInMessage(key,target,{node:id=>state.heap[id],symbolDescription:id=>state.heap[id]?.description}):null;
  if(event.operation!=='primitive.binary'||!site||instruction?.op!=='BINARY'||instruction.arg!=='in'||
    instruction.siteId!==event.siteId||operands.length!==2||!key||!target||
    !['undefined','null','bool','str','num','bigint','symbol'].includes(target[0])||
    row?.allocations?.length!==1||row.allocations[0].identity!==error?.id||changes.length!==1||
    change.before!==null||change.id!==error.id||event.completion?.type!=='throw'||
    event.completion.errorType!=='TypeError'||event.completion.message!==message||
    event.completion.origin!==event.eventId||event.completion.value?.origin!==event.eventId||
    !eq(event.completion.value?.value,['ref',error.id])||error.kind!=='object'||
    error.declaredError!=='TypeError'||error.prototype!=='TypeError.prototype'||
    !eq(Object.keys(error.properties??{}),['message'])||
    !eq(error.dataAttributes?.message,{writable:true,enumerable:false,configurable:true})||
    !eq(error.properties.message?.value,['str',message])||error.properties.message?.origin!==event.eventId)
    throw new TypeError('Source invalid in-operator RHS lacks its exact current TypeError allocation');
  return {key,target,error:error.id};
}
