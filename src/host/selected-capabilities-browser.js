// Browser DOM and timer capabilities for the selected semantic broker.
// All DOM handles and native listeners stay host-owned. Native event handlers
// may submit notifications but never run guest JavaScript synchronously.
const allowedId=value=>typeof value==='string'&&value.length>0;
function ensure(condition,message){if(!condition)throw new TypeError(message);}

export function createDomServices({root,allowedEvents=['click','input','change'],
    allowedAttributes=['class','title','role','aria-label'],maxNodes=256,
    maxString=65536,maxListeners=128,maxTimerMs=60000,
    idFactory=()=>crypto.randomUUID(),eventProfile='passive-notification',
    onDisposition=null}={}){
  ensure(root&&typeof root.querySelector==='function'&&typeof root.contains==='function',
    'The embedding must provide a scoped DOM query root');
  const events=new Set(allowedEvents),attributes=new Set(allowedAttributes);
  ensure(eventProfile==='passive-notification',
    'Only deferred passive event notifications are supported; synchronous propagation control requires a separate handshake');
  for(const value of [maxNodes,maxString,maxListeners,maxTimerMs])
    ensure(Number.isSafeInteger(value)&&value>0,'Browser resource limits require positive integers');
  const handles=new Map(),listeners=new Map(),timers=new Map();
  let aliases=new WeakMap();
  const dispositions=[];
  let closed=false;
  const disposition=record=>{
    dispositions.push(record);onDisposition?.(Object.freeze({...record}));
  };
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
    const owner=JSON.stringify([meta.sessionId,meta.realmId]);
    const known=aliases.get(value)?.get(owner);
    if(known&&handles.has(known)&&!handles.get(known).closed)return known;
    ensure(handles.size<maxNodes,'Browser handle capacity exceeded');
    const id='dom:'+idFactory();
    ensure(allowedId(id)&&!handles.has(id),'Browser handle identity collision');
    handles.set(id,{kind,value,realmId:meta.realmId,sessionId:meta.sessionId,
      closed:false});
    if(!aliases.has(value))aliases.set(value,new Map());
    aliases.get(value).set(owner,id);
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
    disposition({resource:token,state:'closed'});
  };
  const notify=(callback,args,token)=>{
    try{callback(...args);disposition({resource:token,state:'delivered'});}
    catch(error){disposition({resource:token,state:'rejected',reason:String(error.message??error)});}
  };
  const attachAbort=(token,item,meta)=>{
    const abort=()=>{
      try{stop(token,meta);}catch(error){disposition({resource:token,state:'revocation-failed',reason:String(error.message??error)});}
    };
    const close=item.close;
    item.close=()=>{meta.signal?.removeEventListener('abort',abort);close();};
    meta.signal?.addEventListener('abort',abort,{once:true});
    if(meta.signal?.aborted)abort();
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
      handles.delete(element);
    },
    'dom.release':([element],meta)=>{own(element,'element',meta);handles.delete(element);},
    'dom.on':([element,type,_callback],meta)=>{
      string(type,'DOM event');
      if(!events.has(type))throw new Error('DOM event type is not granted');
      ensure(listeners.size<maxListeners,'Browser listener capacity exhausted');
      const target=own(element,'element',meta);
      const callback=meta.callback(2),token=meta.subscriptionId(2);
      ensure(allowedId(token)&&!listeners.has(token)&&!timers.has(token),'Owned callback registration is required');
      let enabled=true;
      const handler=event=>{
        if(!enabled||closed)return;
        // Guest work starts after dispatch, at the owned scheduler checkpoint.
        queueMicrotask(()=>{
          if(enabled&&!closed)notify(callback,[event.type],token);
          else disposition({resource:token,state:'discarded-after-close'});
        });
      };
      target.addEventListener(type,handler,{passive:true});
      listeners.set(token,{realmId:meta.realmId,sessionId:meta.sessionId,
        revoke:()=>meta.closeSubscription(token),
        close:()=>{enabled=false;target.removeEventListener(type,handler);}});
      attachAbort(token,listeners.get(token),meta);
      return token;
    },
    'dom.off':([token],meta)=>stop(token,meta),
    'dom.startTimer':([delay,_callback],meta)=>{
      ensure(typeof delay==='number'&&Number.isSafeInteger(delay)&&
        delay>=0&&delay<=maxTimerMs,'Timer delay outside granted limits');
      ensure(timers.size<maxListeners,'Browser timer capacity exhausted');
      const callback=meta.callback(1),token=meta.subscriptionId(1);
      ensure(allowedId(token)&&!timers.has(token)&&!listeners.has(token),'Owned timer callback required');
      let enabled=true;
      const timer=setTimeout(()=>{
        if(enabled&&!closed)queueMicrotask(()=>{
          if(enabled&&!closed)notify(callback,[token],token);
          else disposition({resource:token,state:'discarded-after-close'});
        });
      },delay);
      timers.set(token,{realmId:meta.realmId,sessionId:meta.sessionId,
        revoke:()=>meta.closeSubscription(token),
        close:()=>{enabled=false;clearTimeout(timer);}});
      attachAbort(token,timers.get(token),meta);
      return token;
    },
    'dom.stopTimer':([token],meta)=>stop(token,meta),
  };
  const window=root.ownerDocument?.defaultView;
  const shutdown=()=>{
      if(closed)return;
      closed=true;
      for(const [token,item] of [...listeners,...timers]){
        item.close();
        try{item.revoke();disposition({resource:token,state:'closed'});}
        catch(error){disposition({resource:token,state:'revocation-failed',reason:String(error.message??error)});}
      }
      handles.clear();listeners.clear();timers.clear();
      aliases=new WeakMap();window?.removeEventListener('pagehide',shutdown);
  };
  window?.addEventListener('pagehide',shutdown,{once:true});
  return {services:Object.freeze(services),close:shutdown,
    inspect(){return {handles:handles.size,listeners:listeners.size,timers:timers.size,
      closed,profile:eventProfile,dispositions:dispositions.map(record=>({...record}))};}
  };
}
