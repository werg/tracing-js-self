// Historical detailed records have ordinary data and closure identities, but
// no class brands, custom prototype links or Proxy target/handler protocol.
// A matching final scalar cannot justify erasing those committed states. The
// shared v8 source coordinator can admit a declared family only when its
// direct adapter checks that family's retained state after every event.
const reject=message=>{const error=new Error('Effectful teacher projection: '+message);
  error.category='unsupported.witness-projection';throw error;};

function inspectHeap(node,before,{boundary=false,protocolProfiles=[]}={}){
  if(!node)return;
  if(node.kind==='proxy'&&!protocolProfiles.includes('ordinary-data-proxy-source/1'))
    reject('Proxy target/handler state requires an explicit v8 protocol profile');
  if(node.classConstructor||node.instanceInitializer||node.staticInitializer||
    ['privateSlots','privateKinds','privateVersions'].some(key=>Object.hasOwn(node,key)))
    reject('class/private state requires an explicit v8 behavioral-state profile');
  if(node.prototypeInitialized||Object.keys(node.dataAttributes??{}).length)
    reject('constructor/prototype descriptors require an explicit v8 behavioral-state profile');
  if(node.extensible===false||node.templateSite||node.templateRawOf)
    reject('frozen template identity and descriptors require an explicit v8 behavioral-state profile');
  if(Object.hasOwn(node,'prototype')){
    const ordinary=node.kind==='array'?'Array.prototype':node.kind==='object'?'Object.prototype':
      node.kind==='function'?'Function.prototype':undefined;
    // Observed ordinary null-prototype objects are already represented by the
    // input/result graph contract. A guest operation changing that link is not.
    const observedNull=node.kind==='object'&&node.prototype===null&&(boundary||before?.prototype===null);
    if(node.prototype!==ordinary&&!observedNull)
      reject('guest custom/null prototype state requires an explicit v8 behavioral-state profile');
  }
}

/** Inspect committed owned snapshots only; never materialize or execute them. */
export function checkEffectfulProjectionState(bundle,{protocolProfiles=[]}={}){
  const number=protocolProfiles.includes('number-conversion-source/1');
  let snapshots=0;
  for(const node of Object.values(bundle.initialState?.heap??{})){inspectHeap(node,null,{boundary:true,protocolProfiles});snapshots++;}
  for(const frame of Object.values(bundle.initialState?.frames??{}))
    if(frame.constructReceiver||frame.newTarget||frame.afterInstanceInitialization||frame.classStaticResult||
      (frame.pendingNumberConversion&&!number)||frame.pendingPropertyKeyConversion)
      reject('construction completion state requires an explicit v8 protocol profile');
  for(const control of Object.values(bundle.initialState?.control??{}))
    if(Object.keys(control.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
  for(const event of bundle.events??[]){
    if(['property.key.convert','property.key.resume'].includes(event.operation))
      reject('retained property-key conversion requires an explicit v8 protocol profile');
    for(const change of event.stateChanges??[]){
    if(change.table==='heap'&&change.after){
      const callbackInput=event.operation==='job.enter'&&event.stateChanges.some(p=>p.table==='frames'&&
        p.before===null&&p.after?.externalCallbackReturn?.graphIdentities.some(item=>item.target===change.id));
      inspectHeap(change.after,change.before,{boundary:change.before===null&&
        (event.operation==='external.input.deliver'||callbackInput),protocolProfiles});snapshots++;
    }
    if(change.table==='frames'&&change.after&&(change.after.constructReceiver||change.after.newTarget||
      change.after.afterInstanceInitialization||change.after.classStaticResult||
      (change.after.pendingNumberConversion&&!number)||change.after.pendingPropertyKeyConversion))
      reject('construction completion state requires an explicit v8 protocol profile');
    if(change.table==='control'&&Object.keys(change.after?.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
    }
  }
  return {valid:true,checkedHeapSnapshots:snapshots};
}
