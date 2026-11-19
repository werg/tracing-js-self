// Historical detailed records have ordinary data and closure identities, but
// no class brands, custom prototype links or Proxy target/handler protocol.
// A matching final scalar cannot justify erasing those committed states.
const reject=message=>{const error=new Error('Effectful teacher projection: '+message);
  error.category='unsupported.witness-projection';throw error;};

function inspectHeap(node,before,{boundary=false}={}){
  if(!node)return;
  if(node.kind==='proxy')reject('Proxy target/handler state requires an explicit v8 protocol profile');
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
export function checkEffectfulProjectionState(bundle){
  let snapshots=0;
  for(const node of Object.values(bundle.initialState?.heap??{})){inspectHeap(node,null,{boundary:true});snapshots++;}
  for(const frame of Object.values(bundle.initialState?.frames??{}))
    if(frame.constructReceiver||frame.newTarget||frame.afterInstanceInitialization||frame.classStaticResult)
      reject('construction completion state requires an explicit v8 protocol profile');
  for(const control of Object.values(bundle.initialState?.control??{}))
    if(Object.keys(control.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
  for(const event of bundle.events??[])for(const change of event.stateChanges??[]){
    if(change.table==='heap'&&change.after){
      inspectHeap(change.after,change.before,{boundary:change.before===null&&event.operation==='external.input.deliver'});snapshots++;
    }
    if(change.table==='frames'&&change.after&&(change.after.constructReceiver||change.after.newTarget||
      change.after.afterInstanceInitialization||change.after.classStaticResult))
      reject('construction completion state requires an explicit v8 protocol profile');
    if(change.table==='control'&&Object.keys(change.after?.templateObjects??{}).length)
      reject('template site identity cache requires an explicit v8 protocol profile');
  }
  return {valid:true,checkedHeapSnapshots:snapshots};
}
