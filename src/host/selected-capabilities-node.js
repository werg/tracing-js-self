// Native adapters for the selected broker. Handles carry explicit ownership;
// native objects, credentials and guest execution never cross the boundary.
import {randomUUID} from 'node:crypto';
import {promises as fs,constants as fsConstants} from 'node:fs';
import {resolve,sep,relative,dirname,basename} from 'node:path';
import {connect as socketConnect} from 'node:net';

function assert(condition,message){if(!condition)throw new TypeError(message);}
function positive(value,name){assert(Number.isSafeInteger(value)&&value>0,'Invalid '+name);}
function withinRoot(root,path){
  const rel=relative(root,path);
  if(rel==='..'||rel.startsWith('..'+sep)||resolve(root,rel)!==path)
    throw new Error('Filesystem operation escapes scoped root');
  return path;
}
function abortScope(signal,controller){
  const abort=()=>controller.abort(signal.reason??new Error('Native operation cancelled'));
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  return ()=>signal?.removeEventListener('abort',abort);
}
function checkOwner(meta){
  assert(meta&&typeof meta.realmId==='string'&&meta.realmId.length&&
    typeof meta.sessionId==='string'&&meta.sessionId.length,'Native resources require an owner');
}

export class NativeCapabilityRegistry {
  constructor({sessionId=null,maxHandles=256,idFactory=randomUUID}={}){
    positive(maxHandles,'native handle capacity');
    this.sessionId=sessionId;this.maxHandles=maxHandles;this.idFactory=idFactory;
    this.handles=new Map();this.closed=false;this.dispositions=[];
  }
  add(kind,value,meta,{origin=null,close=null,checkpoint='lost'}={}){
    checkOwner(meta);
    meta.signal?.throwIfAborted();
    if(this.sessionId!==null&&this.sessionId!==meta.sessionId)
      throw new Error('Native handle belongs to another session');
    if(this.closed||this.handles.size>=this.maxHandles)
      throw new Error('Native capability handle capacity exhausted');
    const handle='cap:'+this.idFactory();
    assert(!this.handles.has(handle),'Native capability identity collision');
    const onAbort=()=>{if(this.handles.has(handle))void this.release(handle,kind,meta).catch(()=>{});};
    this.handles.set(handle,{kind,value,owner:meta.realmId,session:meta.sessionId,
      origin,close,state:'active',checkpoint,
      detach:()=>meta.signal?.removeEventListener('abort',onAbort)});
    meta.signal?.addEventListener('abort',onAbort,{once:true});
    return handle;
  }
  get(handle,kind,meta){
    checkOwner(meta);
    const data=this.handles.get(handle);
    if(this.closed||!data||data.state!=='active'||data.kind!==kind||
       data.owner!==meta.realmId||data.session!==meta.sessionId)
      throw new Error('Unknown, revoked or cross-realm native handle');
    return data;
  }
  async release(handle,kind,meta){
    const data=this.get(handle,kind,meta);
    data.detach?.();
    data.state='closed';this.handles.delete(handle);
    try{await data.close?.();this.dispositions.push({handle,kind,state:'closed'});}
    catch(error){this.dispositions.push({handle,kind,state:'close-failed'});throw error;}
  }
  async close(){
    if(this.closed)return;
    this.closed=true;
    const entries=[...this.handles];this.handles.clear();
    const failures=[];
    for(const [handle,data] of entries){
      data.detach?.();
      data.state='closed';
      try{await data.close?.();this.dispositions.push({handle,kind:data.kind,state:'closed'});}
      catch(error){failures.push(error);this.dispositions.push({handle,kind:data.kind,state:'close-failed'});}
    }
    if(failures.length)throw new AggregateError(failures,'Native resource cleanup failed');
  }
  checkpoint(){
    return {schema:'native-resources/1',resources:[...this.handles].map(([handle,data])=>
      ({handle,kind:data.kind,sessionId:data.session,realmId:data.owner,
        origin:data.origin,state:data.checkpoint}))};
  }
  inspect(){return {closed:this.closed,active:this.handles.size,
    dispositions:structuredClone(this.dispositions)};}
}

/** HTTP redirects, consumption and cancellation are explicit. Each body is
 * consumed once, either as bounded text or through demand-driven chunk reads. */
export function httpServices({allowedOrigins=[],fetcher=fetch,maxBodyBytes=1048576,
    maxRedirects=3,maxChunkBytes=16384,timeoutMs=30000,
    registry=new NativeCapabilityRegistry()}={}){
  for(const [name,value] of Object.entries({maxBodyBytes,maxChunkBytes,timeoutMs}))positive(value,name);
  assert(Number.isSafeInteger(maxRedirects)&&maxRedirects>=0,'Invalid redirect limit');
  const grants=new Set(allowedOrigins.map(origin=>new URL(origin).origin));
  const check=raw=>{
    assert(typeof raw==='string'&&raw.length<=8192,'HTTP URL must be a bounded string');
    const url=new URL(raw);
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password||
       !grants.has(url.origin))throw new Error('HTTP origin not granted');
    return url;
  };
  const makeRequest=async(url,init,meta)=>{
    let current=check(url),redirects=0;
    const controller=new AbortController(),detach=abortScope(meta.signal,controller);
    const timer=setTimeout(()=>controller.abort(new Error('HTTP deadline exceeded')),timeoutMs);
    timer.unref?.();
    let response=null;
    try{
      for(;;){
        controller.signal.throwIfAborted();
        response=await fetcher(current,{...init,signal:controller.signal,
          redirect:'manual',credentials:'omit'});
        if([301,302,303,307,308].includes(response.status)){
          if(redirects++>=maxRedirects)throw new Error('HTTP redirect limit');
          const location=response.headers.get('location');
          if(!location)throw new Error('HTTP redirect missing location');
          const target=check(new URL(location,current).href),status=response.status;
          await response.body?.cancel();response=null;
          if(init.method!=='HEAD'&&(status===303||
            ([301,302].includes(status)&&init.method==='POST')))
            init={...init,method:'GET',body:undefined};
          current=target;continue;
        }
        const state={response,controller,total:0,mode:null,reader:null,buffer:null,
          eof:false,busy:false,error:null};
        const close=async()=>{
          clearTimeout(timer);detach();controller.abort(new Error('HTTP resource closed'));
          try{if(state.reader)await state.reader.cancel();else await response.body?.cancel();}
          finally{state.reader?.releaseLock();state.reader=null;}
        };
        try{return registry.add('http-response',state,meta,{origin:current.origin,close});}
        catch(error){await close();throw error;}
      }
    }catch(error){
      clearTimeout(timer);detach();controller.abort(error);
      try{await response?.body?.cancel();}catch{}
      throw error;
    }
  };
  const body=async(handle,meta,mode)=>{
    const state=registry.get(handle,'http-response',meta).value;
    if(state.error)throw state.error;
    if(state.mode&&state.mode!==mode)throw new Error('HTTP body cannot be consumed twice');
    if(state.busy)throw new Error('HTTP body already has an outstanding read');
    state.mode=mode;if(!state.eof)state.reader??=state.response.body?.getReader();
    return state;
  };
  const next=async state=>{
    state.controller.signal.throwIfAborted();
    if(state.eof)return null;
    if(!state.reader){state.eof=true;return null;}
    const part=await state.reader.read();
    if(part.done){state.eof=true;state.reader.releaseLock();state.reader=null;return null;}
    state.total+=part.value.byteLength;
    if(state.total>maxBodyBytes){
      const error=new RangeError('HTTP response body exceeds cap');state.error=error;
      await state.reader.cancel(error);state.reader.releaseLock();state.reader=null;
      state.controller.abort(error);throw error;
    }
    return part.value;
  };
  const services={
    'http.get':([url],meta)=>makeRequest(url,{method:'GET'},meta),
    'http.post':([url,body],meta)=>{
      assert(typeof body==='string'&&Buffer.byteLength(body,'utf8')<=maxBodyBytes,
        'HTTP POST body exceeds granted bound');
      return makeRequest(url,{method:'POST',body},meta);
    },
    'http.request':([url,method,headerText,body],meta)=>{
      assert(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method),'HTTP method not granted');
      assert(typeof headerText==='string'&&headerText.length<=16384,'Invalid HTTP headers');
      const headers=JSON.parse(headerText);
      assert(headers&&typeof headers==='object'&&!Array.isArray(headers),'HTTP headers require a map');
      for(const [key,value] of Object.entries(headers))
        assert(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)&&typeof value==='string'&&
          !/[\r\n]/.test(value)&&!['authorization','cookie','host','connection','proxy-authorization',
          'content-length','transfer-encoding'].includes(key.toLowerCase()),'HTTP header not granted');
      assert(typeof body==='string'&&Buffer.byteLength(body,'utf8')<=maxBodyBytes,'HTTP request body quota');
      assert(!['GET','HEAD'].includes(method)||body==='','HTTP method cannot carry a body');
      return makeRequest(url,{method,headers,...(body?{body}:{})},meta);
    },
    'http.responseStatus':([handle],meta)=>registry.get(handle,'http-response',meta).value.response.status,
    'http.responseHeaders':([handle],meta)=>{
      const headers=registry.get(handle,'http-response',meta).value.response.headers;
      return JSON.stringify(Object.fromEntries([...headers].filter(([key])=>
        !['set-cookie','set-cookie2'].includes(key.toLowerCase())).sort(([a],[b])=>a.localeCompare(b))));
    },
    'http.responseRead':async([handle],meta)=>{
      const state=await body(handle,meta,'text');
      if(state.consumed)throw new Error('HTTP body cannot be consumed twice');
      state.consumed=true;state.busy=true;
      const chunks=[];
      try{
        for(let part;(part=await next(state))!==null;)chunks.push(part);
        const bytes=new Uint8Array(state.total);let position=0;
        for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}
        return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
      }catch(error){state.error=error;throw error;}
      finally{state.busy=false;}
    },
    'http.responseReadChunk':async([handle],meta)=>{
      const state=await body(handle,meta,'stream');state.busy=true;
      try{
        while(!state.buffer?.byteLength&&!state.eof)state.buffer=await next(state);
        if(!state.buffer?.byteLength)return '';
        const chunk=state.buffer.subarray(0,maxChunkBytes);
        state.buffer=state.buffer.subarray(chunk.byteLength);
        return Buffer.from(chunk).toString('base64');
      }catch(error){state.error=error;throw error;}
      finally{state.busy=false;}
    },
    'http.responseState':([handle],meta)=>{
      const s=registry.get(handle,'http-response',meta).value;
      return JSON.stringify({state:s.error?'failed':s.eof&&!s.buffer?.length?'closed':'open',
        consumedBytes:s.total,bufferedBytes:s.buffer?.byteLength??0});
    },
    'http.responseClose':([handle],meta)=>registry.release(handle,'http-response',meta),
    'http.abort':([handle],meta)=>registry.release(handle,'http-response',meta)
  };
  return Object.freeze(services);
}

/** Host-scoped regular files. Explicit pull/write operations provide bounded
 * backpressure; stream close flushes writes before relinquishing the handle. */
export function nodeFileServices({root,maxBytes=1048576,maxChunkBytes=16384,
    registry=new NativeCapabilityRegistry()}={}){
  assert(typeof root==='string'&&root.length>0,'A host-scoped filesystem root is required');
  positive(maxBytes,'file byte quota');positive(maxChunkBytes,'file chunk quota');
  const absolute=resolve(root);
  const scoped=async(path,{create=false}={})=>{
    assert(typeof path==='string'&&!path.includes('\0')&&path.length<=4096,'Invalid file capability path');
    const candidate=withinRoot(absolute,resolve(absolute,path));
    const actualRoot=await fs.realpath(absolute);
    if(!create)return withinRoot(actualRoot,await fs.realpath(candidate));
    const parent=withinRoot(actualRoot,await fs.realpath(dirname(candidate)));
    return withinRoot(actualRoot,resolve(parent,basename(candidate)));
  };
  const size=bytes=>{
    assert(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=maxBytes,
      'Native content exceeds scoped byte quota');return bytes;
  };
  const open=async(path,write)=>{
    const name=await scoped(path,{create:write});
    const file=await fs.open(name,write?fsConstants.O_WRONLY|fsConstants.O_CREAT|
      fsConstants.O_TRUNC|fsConstants.O_NOFOLLOW:fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW,0o600);
    try{
      const stat=await file.stat();
      assert(stat.isFile(),'File capability requires a regular file');
      if(stat.size>maxBytes)throw new RangeError('Read byte quota');
      return {file,size:stat.size,position:0,busy:false};
    }catch(error){await file.close();throw error;}
  };
  return Object.freeze({
    'fs.readText':async([path])=>{
      const {file}=await open(path,false);
      try{
        const chunks=[];let total=0;
        for(;;){
          const buffer=Buffer.alloc(Math.min(maxChunkBytes,maxBytes-total+1));
          const {bytesRead}=await file.read(buffer,0,buffer.length,null);
          if(!bytesRead)break;total+=bytesRead;
          if(total>maxBytes)throw new RangeError('Read byte quota');
          chunks.push(buffer.subarray(0,bytesRead));
        }
        return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
      }finally{await file.close();}
    },
    'fs.writeText':async([path,body])=>{
      size(body);const {file}=await open(path,true);
      try{await file.writeFile(body,'utf8');await file.sync();}finally{await file.close();}
    },
    'fs.list':async([path])=>{
      const names=await fs.readdir(await scoped(path));
      if(names.length>2048)throw new RangeError('Directory item cap');
      return size(JSON.stringify(names.sort()));
    },
    'fs.openRead':async([path],meta)=>{
      const state=await open(path,false);
      try{return registry.add('fs-reader',state,meta,{close:()=>state.file.close()});}
      catch(error){await state.file.close();throw error;}
    },
    'fs.readChunk':async([handle],meta)=>{
      const stream=registry.get(handle,'fs-reader',meta).value;
      if(stream.busy)throw new Error('File stream already has an outstanding read');
      if(stream.position>=stream.size)return '';
      stream.busy=true;
      try{
        const length=Math.min(maxChunkBytes,stream.size-stream.position),buffer=Buffer.alloc(length);
        const {bytesRead}=await stream.file.read(buffer,0,length,stream.position);
        stream.position+=bytesRead;if(!bytesRead)stream.size=stream.position;
        return buffer.subarray(0,bytesRead).toString('base64');
      }finally{stream.busy=false;}
    },
    'fs.openWrite':async([path],meta)=>{
      const state=await open(path,true);
      try{return registry.add('fs-writer',state,meta,{close:async()=>{
        try{await state.file.sync();}finally{await state.file.close();}
      }});}catch(error){await state.file.close();throw error;}
    },
    'fs.writeChunk':async([handle,text],meta)=>{
      assert(typeof text==='string'&&text.length<=Math.ceil(maxChunkBytes/3)*4&&
        Buffer.from(text,'base64').toString('base64')===text,'Invalid bounded base64 chunk');
      const stream=registry.get(handle,'fs-writer',meta).value,bytes=Buffer.from(text,'base64');
      if(stream.busy)throw new Error('File stream already has an outstanding write');
      if(bytes.length>maxChunkBytes||stream.position+bytes.length>maxBytes)
        throw new RangeError('File stream write quota');
      stream.busy=true;
      try{
        let offset=0;
        while(offset<bytes.length){
          const {bytesWritten}=await stream.file.write(bytes,offset,bytes.length-offset,stream.position);
          if(!bytesWritten)throw new Error('File stream made no write progress');
          offset+=bytesWritten;stream.position+=bytesWritten;
        }
        return bytes.length;
      }finally{stream.busy=false;}
    },
    'fs.close':([handle],meta)=>registry.release(handle,'fs-reader',meta),
    'fs.closeWrite':([handle],meta)=>registry.release(handle,'fs-writer',meta)
  });
}

/** A paused native socket is only read on guest demand. EOF, transport error,
 * cancellation and timeout stay distinct; at most one read/write is pending. */
export function nodeSocketServices({allowedEndpoints=[],registry=new NativeCapabilityRegistry(),
    maxPendingBytes=1048576,maxChunkBytes=16384,timeoutMs=30000}={}){
  for(const [name,value] of Object.entries({maxPendingBytes,maxChunkBytes,timeoutMs}))positive(value,name);
  const allowed=new Set(allowedEndpoints);
  return Object.freeze({
    'net.connect':async([host,port],meta)=>{
      assert(typeof host==='string'&&Number.isInteger(port)&&port>0&&port<=65535,'Invalid socket destination');
      if(!allowed.has(host+':'+port))throw new Error('Socket endpoint not granted');
      meta.signal?.throwIfAborted();
      const socket=socketConnect({host,port,highWaterMark:Math.min(maxPendingBytes,maxChunkBytes)});
      const state={socket,error:null,reading:false,writing:false,closed:false};
      const failed=error=>{state.error=error;};socket.on('error',failed);
      socket.on('timeout',()=>socket.destroy(new Error('Socket deadline exceeded')));
      socket.setTimeout(timeoutMs);socket.pause();
      const abort=()=>socket.destroy(meta.signal.reason??new Error('Socket cancelled'));
      meta.signal?.addEventListener('abort',abort,{once:true});
      const close=()=>{state.closed=true;meta.signal?.removeEventListener('abort',abort);socket.destroy();};
      try{
        await new Promise((resolve,reject)=>{
          const cleanup=()=>{socket.off('connect',connected);socket.off('error',error);socket.off('close',closed);};
          const connected=()=>{cleanup();resolve();};
          const error=e=>{cleanup();reject(e);};
          const closed=()=>error(state.error??new Error('Socket closed before connection'));
          socket.once('connect',connected);socket.once('error',error);socket.once('close',closed);
        });
        return registry.add('socket',state,meta,{origin:host+':'+port,close});
      }catch(error){close();throw error;}
    },
    'net.write':async([handle,bytes],meta)=>{
      assert(typeof bytes==='string'&&Buffer.byteLength(bytes,'utf8')<=maxPendingBytes,'Socket write quota');
      const state=registry.get(handle,'socket',meta).value;
      if(state.error)throw state.error;
      if(state.writing)throw new Error('Socket already has an outstanding write');
      if(state.socket.destroyed||state.socket.writableEnded)throw new Error('Socket is closed for writing');
      state.writing=true;
      try{await new Promise((resolve,reject)=>state.socket.write(bytes,'utf8',error=>error?reject(error):resolve()));}
      finally{state.writing=false;}
    },
    'net.read':async([handle],meta)=>{
      const state=registry.get(handle,'socket',meta).value,{socket}=state;
      if(state.error)throw state.error;
      if(state.reading)throw new Error('Socket already has an outstanding read');
      state.reading=true;
      try{
        const data=await new Promise((resolve,reject)=>{
          const cleanup=()=>{socket.off('readable',read);socket.off('end',read);
            socket.off('error',error);socket.off('close',closed);};
          const done=value=>{cleanup();resolve(value);};
          const error=e=>{cleanup();reject(e);};
          const closed=()=>state.error?error(state.error):state.closed?
            error(new Error('Socket cancelled or closed during read')):done(Buffer.alloc(0));
          const read=()=>{
            if(state.error)return error(state.error);
            const bytes=socket.read(Math.min(socket.readableLength,maxChunkBytes)||undefined);
            if(bytes)return bytes.length>maxPendingBytes?error(new RangeError('Socket read quota')):done(bytes);
            if(socket.readableEnded)return done(Buffer.alloc(0));
            if(socket.destroyed)closed();
          };
          socket.on('readable',read);socket.once('end',read);socket.once('error',error);socket.once('close',closed);
          read();
        });
        return data.toString('base64');
      }finally{state.reading=false;}
    },
    'net.close':([handle],meta)=>registry.release(handle,'socket',meta)
  });
}

export function nativeServiceCatalog({http=null,files=null,sockets=null,
    registry=new NativeCapabilityRegistry()}={}){
  const catalog=Object.create(null);
  if(http)Object.assign(catalog,httpServices({...http,registry}));
  if(files)Object.assign(catalog,nodeFileServices({...files,registry}));
  if(sockets)Object.assign(catalog,nodeSocketServices({...sockets,registry}));
  return {services:catalog,registry};
}
