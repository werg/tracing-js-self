import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeCapabilityRegistry,httpServices,nodeFileServices,nodeSocketServices}
  from '../src/host/selected-capabilities-node.js';
const owner={sessionId:'session',realmId:'realm'};
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close=server=>new Promise(resolve=>server.close(resolve));

test('real HTTP request, status, redirects and streaming retain one response without refetch',async()=>{
  const requests=[];
  const server=httpServer((req,res)=>{
    requests.push({method:req.method,url:req.url});
    if(req.url==='/redirect'){res.writeHead(303,{location:'/body'});res.end();return;}
    res.writeHead(206,{'content-type':'text/plain','set-cookie':'secret=hidden'});
    res.write('ab');res.end('cdef');
  });
  await listen(server);
  const origin='http://127.0.0.1:'+server.address().port;
  const registry=new NativeCapabilityRegistry();
  const services=httpServices({registry,allowedOrigins:[origin],maxChunkBytes:2});
  try{
    const handle=await services['http.request']([origin+'/redirect','POST','{}','payload'],owner);
    assert.equal(services['http.responseStatus']([handle],owner),206);
    assert(!services['http.responseHeaders']([handle],owner).includes('set-cookie'));
    const parts=[];
    for(;;){const value=await services['http.responseReadChunk']([handle],owner);if(!value)break;
      const bytes=Buffer.from(value,'base64');assert(bytes.length<=2);parts.push(bytes);}
    assert.equal(Buffer.concat(parts).toString(),'abcdef');
    assert.deepEqual(requests,[{method:'POST',url:'/redirect'},{method:'GET',url:'/body'}]);
    assert.equal(JSON.parse(services['http.responseState']([handle],owner)).state,'closed');
    await assert.rejects(services['http.responseRead']([handle],owner),/twice/);
    await services['http.responseClose']([handle],owner);
  }finally{await registry.close();server.closeAllConnections();await close(server);}
});

test('HTTP caller cancellation aborts an in-flight request before a response handle exists',async()=>{
  const server=httpServer((_req,_res)=>{});await listen(server);
  const origin='http://127.0.0.1:'+server.address().port,controller=new AbortController();
  const services=httpServices({allowedOrigins:[origin]});
  const request=services['http.get']([origin],{...owner,signal:controller.signal});
  controller.abort(new Error('cancelled by owner'));
  try{await assert.rejects(request,/cancelled/);}
  finally{server.closeAllConnections();await close(server);}
});

test('HTTP quota, concurrent consumption and cross-origin redirects fail before hidden work',async()=>{
  let cancelled=0,calls=0;
  const registry=new NativeCapabilityRegistry();
  const services=httpServices({registry,allowedOrigins:['https://allowed.test'],maxBodyBytes:2,
    fetcher:async()=>{calls++;return new Response(new ReadableStream({
      start(controller){controller.enqueue(new Uint8Array([1,2,3]));},
      cancel(){cancelled++;}
    }));}});
  const handle=await services['http.get'](['https://allowed.test'],owner);
  await assert.rejects(services['http.responseRead']([handle],owner),/cap/);
  assert.equal(cancelled,1);assert.equal(calls,1);await registry.close();
  const denied=httpServices({allowedOrigins:['https://allowed.test'],fetcher:async()=>{
    calls++;return new Response('',{status:302,headers:{location:'https://foreign.test'}});
  }});
  await assert.rejects(denied['http.get'](['https://allowed.test'],owner),/not granted/);
  assert.equal(calls,2);
});

test('bounded write streams flush and close, reject concurrent/foreign writes and retain exact bytes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'selected-writer-')),registry=new NativeCapabilityRegistry();
  const services=nodeFileServices({root,registry,maxBytes:6,maxChunkBytes:3});
  try{
    const handle=await services['fs.openWrite'](['output'],owner);
    assert.equal(await services['fs.writeChunk']([handle,'YWJj'],owner),3);
    await assert.rejects(services['fs.writeChunk']([handle,'ZA=='],{...owner,realmId:'foreign'}),/cross-realm/);
    assert.equal(await services['fs.writeChunk']([handle,'ZGVm'],owner),3);
    await assert.rejects(services['fs.writeChunk']([handle,'Zw=='],owner),/quota/);
    await services['fs.closeWrite']([handle],owner);
    assert.equal(await readFile(join(root,'output'),'utf8'),'abcdef');
    await assert.rejects(services['fs.writeChunk']([handle,''],owner),/revoked/);
  }finally{await registry.close();await rm(root,{recursive:true,force:true});}
});

test('socket idle timeout rejects a pending read instead of hanging or reporting EOF',async()=>{
  const sockets=new Set(),server=tcpServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await listen(server);const port=server.address().port,registry=new NativeCapabilityRegistry();
  const services=nodeSocketServices({registry,allowedEndpoints:['127.0.0.1:'+port],timeoutMs:30});
  try{
    const handle=await services['net.connect'](['127.0.0.1',port],owner);
    await assert.rejects(services['net.read']([handle],owner),/deadline/);
  }finally{await registry.close();for(const socket of sockets)socket.destroy();await close(server);}
});

test('registry cleanup continues after a failed resource close and records each disposition',async()=>{
  const registry=new NativeCapabilityRegistry();let closed=0;
  registry.add('test',{},owner,{close:()=>{throw new Error('failure');}});
  registry.add('test',{},owner,{close:()=>{closed++;}});
  await assert.rejects(registry.close(),AggregateError);
  assert.equal(closed,1);assert.equal(registry.inspect().active,0);
  assert.deepEqual(registry.inspect().dispositions.map(r=>r.state),['close-failed','closed']);
});
