// Registered Node/HTTP resource operations for the selected effect broker.
// Native objects remain behind opaque per-realm capability handles. No guest
// getter, eval, implicit network permission, or unchecked file path is exposed.
import {randomUUID} from 'node:crypto';
import {promises as fs,constants as fsConstants} from 'node:fs';
import {resolve,sep,relative,dirname} from 'node:path';
import {once} from 'node:events';
import {connect as socketConnect} from 'node:net';

const own=Object.hasOwn;
function assert(condition,message){if(!condition)throw new TypeError(message);}
function withinRoot(root,path){
  const rel=relative(root,path);
  if(rel==='..'||rel.startsWith('..'+sep)||resolve(root,rel)!==path)
    throw new Error('Filesystem operation escapes scoped root');
  return path;
}

export class NativeCapabilityRegistry {
  constructor({sessionId='session',maxHandles=256}={}){
    this.sessionId=sessionId;this.maxHandles=maxHandles;
    this.handles=new Map();this.closed=false;
  }
  add(kind,value,meta,{origin=null,close=null}={}){
    if(this.closed||this.handles.size>=this.maxHandles)
      throw new Error('Native capability handle capacity exhausted');
    const handle='cap:'+randomUUID();
    this.handles.set(handle,{kind,value,owner:meta.realmId,session:meta.sessionId,
      origin,close,state:'active'});
    return handle;
  }
  get(handle,kind,meta){
    const data=this.handles.get(handle);
    if(!data||data.state!=='active'||data.kind!==kind||
       data.owner!==meta.realmId||data.session!==meta.sessionId)
      throw new Error('Unknown, revoked or cross-realm native handle');
    return data;
  }
  async release(handle,kind,meta){
    const data=this.get(handle,kind,meta);
    data.state='closed';this.handles.delete(handle);
    await data.close?.();
  }
  async close(){
    if(this.closed)return;
    this.closed=true;
    const entries=[...this.handles.values()];
    this.handles.clear();
    for(const data of entries){
      data.state='closed';await data.close?.();
    }
  }
  checkpoint(){
    // External resource identities are not restorable without adapter-specific
    // reattachment; a crash must report loss, not fabricate live continuations.
    return {schema:'native-resources/1',resources:[...this.handles].map(([handle,data])=>
      ({handle,kind:data.kind,realmId:data.owner,state:'lost'}))};
  }
}

/** Register only exact requested URL origins; redirects are checked at every
 * hop through redirect='manual' and never leak grant data across origins.
 * Stream bodies are consumed through explicit bounded pull operations. */
export function httpServices({allowedOrigins=[],fetcher=fetch,
    maxBodyBytes=1048576,maxRedirects=3,registry=new NativeCapabilityRegistry()}={}){
  const grants=new Set(allowedOrigins);
  const check=raw=>{
    assert(typeof raw==='string'&&raw.length<=8192,'HTTP URL must be a bounded string');
    const url=new URL(raw);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||
       !grants.has(url.origin))throw new Error('HTTP origin not granted');
    return url;
  };
  const makeRequest=async(url,init,meta)=>{
    let current=check(url),redirects=0;
    const controller=new AbortController();
    for(;;){
      const response=await fetcher(current,{...init,signal:controller.signal,
        redirect:'manual',credentials:'omit'});
      if(response.status>=300&&response.status<400){
        if(redirects++>=maxRedirects){
          controller.abort();throw new Error('HTTP redirect limit');
        }
        const location=response.headers.get('location');
        if(!location){controller.abort();throw new Error('HTTP redirect missing location');}
        current=check(new URL(location,current).href);
        await response.body?.cancel();
        continue;
      }
      return registry.add('http-response',{response,controller,total:0},meta,
        {origin:current.origin,close:async()=>{
          controller.abort();try{await response.body?.cancel();}catch{}
        }});
    }
  };
  return Object.freeze({
    'http.get':([url],meta)=>makeRequest(url,{method:'GET'},meta),
    'http.post':([url,body],meta)=>{
      assert(typeof body==='string'&&Buffer.byteLength(body,'utf8')<=maxBodyBytes,
        'HTTP POST body exceeds granted bound');
      return makeRequest(url,{method:'POST',body},meta);
    },
    'http.responseStatus':([handle],meta)=>registry.get(handle,'http-response',meta)
      .value.response.status,
    'http.responseRead':async([handle],meta)=>{
      const item=registry.get(handle,'http-response',meta).value;
      if(item.consumed)throw new Error('HTTP body cannot be consumed twice');
      item.consumed=true;
      const reader=item.response.body?.getReader();
      if(!reader)return '';
      const chunks=[];let total=0;
      try{
        for(;;){
          const part=await reader.read();if(part.done)break;
          total+=part.value.byteLength;
          if(total>maxBodyBytes)throw new RangeError('HTTP response body exceeds cap');
          chunks.push(part.value);
        }
      }finally{reader.releaseLock();}
      const bytes=new Uint8Array(total);let pos=0;
      for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    },
    'http.responseClose':async([handle],meta)=>{
      await registry.release(handle,'http-response',meta);
    },
    'http.abort':async([handle],meta)=>{
      await registry.release(handle,'http-response',meta);
    }
  });
}

/** One root, realpath-scoped reads/writes; bounded streaming reads apply
 * backpressure by returning one chunk only on each explicit guest request. */
export function nodeFileServices({root,maxBytes=1048576,registry=new NativeCapabilityRegistry()}={}){
  assert(typeof root==='string'&&root.length>0,'A host-scoped filesystem root is required');
  const absolute=resolve(root);
  const scoped=async(path,{create=false}={})=>{
    assert(typeof path==='string'&&!path.includes('\0')&&path.length<=4096,
      'Invalid file capability path');
    const candidate=withinRoot(absolute,resolve(absolute,path));
    const actualRoot=await fs.realpath(absolute);
    const parent=await fs.realpath(create?dirname(candidate):candidate);
    withinRoot(actualRoot,parent);
    return candidate;
  };
  const size=bytes=>{
    assert(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=maxBytes,
      'Native content exceeds scoped byte quota');
    return bytes;
  };
  return Object.freeze({
    'fs.readText':async([path])=>{
      const name=await scoped(path);
      const stat=await fs.stat(name);if(stat.size>maxBytes)throw new RangeError('Read byte quota');
      return size(await fs.readFile(name,'utf8'));
    },
    'fs.writeText':async([path,body])=>{
      size(body);
      const name=await scoped(path,{create:true});
      // O_NOFOLLOW prevents replacing a file through a leaf symlink.
      const file=await fs.open(name,fsConstants.O_WRONLY|fsConstants.O_CREAT|
        fsConstants.O_TRUNC|fsConstants.O_NOFOLLOW,0o600);
      try{await file.writeFile(body,'utf8');await file.sync();}
      finally{await file.close();}
    },
    'fs.list':async([path])=>{
      const name=await scoped(path);
      const names=await fs.readdir(name);
      if(names.length>2048)throw new RangeError('Directory item cap');
      return size(JSON.stringify(names.sort()));
    },
    'fs.openRead':async([path],meta)=>{
      const name=await scoped(path);
      const file=await fs.open(name,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);
      try{
        const stat=await file.stat();
        if(stat.size>maxBytes)throw new RangeError('Stream byte quota');
        return registry.add('fs-reader',{file,position:0,size:stat.size},meta,
          {close:()=>file.close()});
      }catch(error){await file.close();throw error;}
    },
    'fs.readChunk':async([handle],meta)=>{
      const stream=registry.get(handle,'fs-reader',meta).value;
      if(stream.position>=stream.size)return '';
      const max=Math.min(16384,stream.size-stream.position);
      const buffer=Buffer.alloc(max);
      const result=await stream.file.read(buffer,0,max,stream.position);
      stream.position+=result.bytesRead;
      return buffer.subarray(0,result.bytesRead).toString('base64');
    },
    'fs.close':async([handle],meta)=>registry.release(handle,'fs-reader',meta)
  });
}

/** Scoped TCP endpoints. Each read is one host-arrived chunk; buffering is
 * capped and the guest must request the next chunk. The host owns the socket. */
export function nodeSocketServices({allowedEndpoints=[],registry=new NativeCapabilityRegistry(),
    maxPendingBytes=1048576,timeoutMs=30000}={}){
  const allowed=new Set(allowedEndpoints);
  return Object.freeze({
    'net.connect':async([host,port],meta)=>{
      assert(typeof host==='string'&&Number.isInteger(port)&&port>0&&port<=65535,
        'Invalid socket destination');
      if(!allowed.has(host+':'+port))throw new Error('Socket endpoint not granted');
      const socket=socketConnect({host,port});
      socket.pause();socket.setTimeout(timeoutMs);
      try{await Promise.race([once(socket,'connect'),once(socket,'error').then(
        ([e])=>Promise.reject(e))]);}
      catch(error){socket.destroy();throw error;}
      return registry.add('socket',{socket,pendingBytes:0},meta,{
        origin:host+':'+port,close:()=>{socket.destroy();}
      });
    },
    'net.write':async([handle,bytes],meta)=>{
      assert(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=maxPendingBytes,
        'Socket write quota');
      const {socket}=registry.get(handle,'socket',meta).value;
      if(!socket.write(bytes,'utf8'))await once(socket,'drain');
    },
    'net.read':async([handle],meta)=>{
      const {socket}=registry.get(handle,'socket',meta).value;
      if(socket.destroyed)return '';
      socket.resume();
      try{
        const item=await Promise.race([
          once(socket,'data').then(([b])=>({data:b})),
          once(socket,'end').then(()=>({data:Buffer.alloc(0)})),
          once(socket,'error').then(([err])=>Promise.reject(err))
        ]);
        if(item.data.byteLength>maxPendingBytes)throw new RangeError('Socket read quota');
        return item.data.toString('base64');
      }finally{socket.pause();}
    },
    'net.close':async([handle],meta)=>registry.release(handle,'socket',meta)
  });
}

/** Registry assembled by the embedding. The default is no grant at all.
 * No tool can widen the host's explicit origins, paths or endpoint scopes. */
export function nativeServiceCatalog({http=null,files=null,sockets=null,
    registry=new NativeCapabilityRegistry()}={}){
  const catalog=Object.create(null);
  if(http)Object.assign(catalog,httpServices({...http,registry}));
  if(files)Object.assign(catalog,nodeFileServices({...files,registry}));
  if(sockets)Object.assign(catalog,nodeSocketServices({...sockets,registry}));
  return {services:catalog,registry};
}
