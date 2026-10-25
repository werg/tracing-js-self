// Browser DOM and timer capabilities for the selected semantic broker.
// All DOM handles and native listeners stay host-owned. Native event handlers
// may submit notifications but never run guest JavaScript synchronously.
const allowedId=value=>typeof value==='string'&&value.length>0;
function ensure(condition,message){if(!condition)throw new TypeError(message);}

export function createDomServices({root,allowedEvents=['click','input','change'],
    allowedAttributes=['class','title','role','aria-label'],maxNodes=256,
    maxString=65536,maxListeners=128,maxTimerMs=60000,
    idFactory=()=>crypto.randomUUID()}={}){
  ensure(root&&typeof root.querySelector==='function'&&typeof root.contains==='function',
    'The embedding must provide a scoped DOM query root');
  const events=new Set(allowedEvents),attributes=new Set(allowedAttributes);
  const handles=new Map(),listeners=new Map(),timers=new Map();
  let closed=false;
  const active=()=>{if(closed)throw new Error('DOM capability scope is closed');};
  const own=(handle,kind,meta)=>{
    active();
    const item=handles.get(handle);
    if(!item||item.kind!==kind||item.realmId!==meta.realmId||
       item.sessionId!==meta.sessionId||item.closed)
      throw new Error('Unknown, stale or cross-realm browser resource');
    if(kind==='element'&&!root.contains(item.value))
      throw new Error('DOM element was detached from authorized root');
    return item.value;
  };
  const handle=(kind,value,meta)=>{
    active();
    ensure(handles.size<maxNodes,'Browser handle capacity exceeded');
    const id='dom:'+idFactory();
    ensure(allowedId(id)&&!handles.has(id),'Browser handle identity collision');
    handles.set(id,{kind,value,realmId:meta.realmId,sessionId:meta.sessionId,
      closed:false});
    return id;
  };
  const string=(v,what)=>{
    ensure(typeof v==='string'&&v.length<=maxString,'Invalid bounded '+what);
    return v;
  };
  const stop=(token,meta)=>{
    const item=listeners.get(token)??timers.get(token);
    if(!item||item.realmId!==meta.realmId||item.sessionId!==meta.sessionId)
      throw new Error('Subscription is revoked or foreign');
    item.close();
    listeners.delete(token);timers.delete(token);
    meta.closeSubscription(token);
  };
  const services={
    'dom.query':([selector],meta)=>{
      string(selector,'CSS selector');
      const element=root.querySelector(selector);
      return element?handle('element',element,meta):'';
    },
    'dom.getText':([element],meta)=>
      string(String(own(element,'element',meta).textContent??''),'DOM text'),
    'dom.setText':([element,text],meta)=>{
      string(text,'DOM text');
      own(element,'element',meta).textContent=text;
    },
    'dom.setAttribute':([element,name,value],meta)=>{
      string(name,'DOM attribute');string(value,'DOM attribute value');
      if(!attributes.has(name))throw new Error('DOM attribute is not granted');
      own(element,'element',meta).setAttribute(name,value);
    },
    'dom.getAttribute':([element,name],meta)=>{
      string(name,'DOM attribute');
      if(!attributes.has(name))throw new Error('DOM attribute is not granted');
      return own(element,'element',meta).getAttribute(name)??'';
    },
    'dom.remove':([element],meta)=>{
      const node=own(element,'element',meta);
      node.remove();
      handles.get(element).closed=true;
    },
    'dom.on':([element,type,_callback],meta)=>{
      string(type,'DOM event');
      if(!events.has(type))throw new Error('DOM event type is not granted');
      ensure(listeners.size<maxListeners,'Browser listener capacity exhausted');
      const target=own(element,'element',meta);
      const callback=meta.callback(2),token=meta.subscriptionId(2);
      ensure(allowedId(token)&&!listeners.has(token),'Owned callback registration is required');
      let enabled=true;
      const handler=event=>{
        if(!enabled||closed)return;
        // Guest work starts after dispatch, at the owned scheduler checkpoint.
        queueMicrotask(()=>{
          if(enabled&&!closed)callback(event.type);
        });
      };
      target.addEventListener(type,handler,{passive:true});
      listeners.set(token,{realmId:meta.realmId,sessionId:meta.sessionId,
        close:()=>{enabled=false;target.removeEventListener(type,handler);}});
      return token;
    },
    'dom.off':([token],meta)=>stop(token,meta),
    'dom.startTimer':([delay,_callback],meta)=>{
      ensure(typeof delay==='number'&&Number.isSafeInteger(delay)&&
        delay>=0&&delay<=maxTimerMs,'Timer delay outside granted limits');
      ensure(timers.size<maxListeners,'Browser timer capacity exhausted');
      const callback=meta.callback(1),token=meta.subscriptionId(1);
      ensure(allowedId(token)&&!timers.has(token),'Owned timer callback required');
      let enabled=true;
      const timer=setTimeout(()=>{
        timers.delete(token);
        if(enabled&&!closed)queueMicrotask(()=>{if(enabled&&!closed)callback(token);});
      },delay);
      timers.set(token,{realmId:meta.realmId,sessionId:meta.sessionId,
        close:()=>{enabled=false;clearTimeout(timer);}});
      return token;
    },
    'dom.stopTimer':([token],meta)=>stop(token,meta),
  };
  return {services:Object.freeze(services),
    close(){
      if(closed)return;
      closed=true;
      for(const item of [...listeners.values(),...timers.values()])item.close();
      handles.clear();listeners.clear();timers.clear();
    },
    inspect(){return {handles:handles.size,listeners:listeners.size,timers:timers.size,
      closed};}
  };
}
