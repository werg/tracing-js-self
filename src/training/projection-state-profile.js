// Historical detailed records have ordinary data and closure identities, but
// no class brands, custom prototype links or Proxy target/handler protocol.
// A matching final scalar cannot justify erasing those committed states. The
// shared v8 source coordinator can admit a declared family only when its
// direct adapter checks that family's retained state after every event.
import {ownedExceptionFields} from './owned-exception-profile.js';
const reject=message=>{const error=new Error('Effectful teacher projection: '+message);
  error.category='unsupported.witness-projection';throw error;};

function inspectHeap(node,before,{boundary=false,protocolProfiles=[],exceptionProfile=false}={}){
  if(!node)return;
  if(exceptionProfile&&node.declaredError){ownedExceptionFields(node);return;}
  const generator=protocolProfiles.includes('synchronous-generator-source/1')&&
    (node.generatorFunction===true||node.kind==='generator'||node.kind==='object'&&node.prototype==='Generator.prototype');
  const ordinaryObject=protocolProfiles.includes('promise-object-source/1')&&['object','array'].includes(node.kind);
  if(node.kind==='proxy'&&!protocolProfiles.includes('ordinary-data-proxy-source/1'))
    reject('Proxy target/handler state requires an explicit v8 protocol profile');
  if(node.classConstructor||node.instanceInitializer||node.staticInitializer||
    ['privateSlots','privateKinds','privateVersions'].some(key=>Object.hasOwn(node,key)))
    reject('class/private state requires an explicit v8 behavioral-state profile');
  if(!generator&&!ordinaryObject&&(node.prototypeInitialized||Object.keys(node.dataAttributes??{}).length))
    reject('constructor/prototype descriptors require an explicit v8 behavioral-state profile');
  if((!generator&&!ordinaryObject&&node.extensible===false)||node.templateSite||node.templateRawOf)
    reject('frozen template identity and descriptors require an explicit v8 behavioral-state profile');
  if(Object.hasOwn(node,'prototype')){
    const ordinary=node.kind==='array'?'Array.prototype':node.kind==='object'?'Object.prototype':
      node.kind==='function'?'Function.prototype':undefined;
    // Observed ordinary null-prototype objects are already represented by the
    // input/result graph contract. A guest operation changing that link is not.
    const observedNull=node.kind==='object'&&node.prototype===null&&(boundary||before?.prototype===null);
    if(node.prototype!==ordinary&&!observedNull&&!generator&&!ordinaryObject)
      reject('guest custom/null prototype state requires an explicit v8 behavioral-state profile');
  }
}

/** Inspect committed owned snapshots only; never materialize or execute them. */
export function checkEffectfulProjectionState(bundle,{protocolProfiles=[],exceptionProfile=false}={}){
  const conversion=protocolProfiles.includes('primitive-conversion-source/1'),
    number=conversion||protocolProfiles.includes('number-conversion-source/1');
  let snapshots=0;
  for(const node of Object.values(bundle.initialState?.heap??{})){inspectHeap(node,null,{boundary:true,protocolProfiles,exceptionProfile});snapshots++;}
  for(const frame of Object.values(bundle.initialState?.frames??{}))
    if(frame.constructReceiver||frame.newTarget||frame.afterInstanceInitialization||frame.classStaticResult||
      (frame.pendingNumberConversion&&!number)||(frame.pendingPropertyKeyConversion&&!conversion))
      reject('construction completion state requires an explicit v8 protocol profile');
  for(const control of Object.values(bundle.initialState?.control??{}))
    if(Object.keys(control.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
  const errorIds=new Set(Object.values(bundle.finalState?.heap??{}).filter(node=>node.declaredError).map(node=>node.id));
  for(const event of bundle.events??[]){
    if(exceptionProfile){
      const operands=event.operands??[],raw=operands[0],callee=raw?.[0]==='method'?raw[1]:raw,
        affected=operands.some(value=>value?.[0]==='ref'&&errorIds.has(value[1]))||
          raw?.[0]==='method'&&raw[2]?.[0]==='ref'&&errorIds.has(raw[2][1]);
      if(affected&&(event.operation==='property.read'&&!['name','message'].includes(operands[1]?.[1])||
        ['property.write','property.delete','property.update'].includes(event.operation)||
        event.operation==='call.enter'&&['builtinfn','intrinsic'].includes(callee?.[0])))
        reject('Error reflection or mutation requires its ordinary v8 object profile');
    }
    if(!conversion&&['property.key.convert','property.key.resume'].includes(event.operation))
      reject('retained property-key conversion requires an explicit v8 protocol profile');
    for(const change of event.stateChanges??[]){
    if(change.table==='heap'&&change.after){
      const callbackInput=event.operation==='job.enter'&&event.stateChanges.some(p=>p.table==='frames'&&
        p.before===null&&p.after?.externalCallbackReturn?.graphIdentities.some(item=>item.target===change.id));
      inspectHeap(change.after,change.before,{boundary:change.before===null&&
        (event.operation==='external.input.deliver'||callbackInput),protocolProfiles,exceptionProfile});snapshots++;
    }
    if(change.table==='frames'&&change.after&&(change.after.constructReceiver||change.after.newTarget||
      change.after.afterInstanceInitialization||change.after.classStaticResult||
      (change.after.pendingNumberConversion&&!number)||(change.after.pendingPropertyKeyConversion&&!conversion)))
      reject('construction completion state requires an explicit v8 protocol profile');
    if(change.table==='control'&&Object.keys(change.after?.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
    }
  }
  return {valid:true,checkedHeapSnapshots:snapshots};
}
