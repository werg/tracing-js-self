import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,readFile,symlink,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {NativeCapabilityRegistry,nativeServiceCatalog,httpServices}
  from '../src/host/selected-capabilities-node.js';

const identity={sessionId:'s1',realmId:'r1',invocationId:'i1'};
test('file capabilities confine filesystem, preserve stream pull and close lifecycle',async()=>{
  const root=await mkdtemp(join(tmpdir(),'selected-fs-'));
  const outside=await mkdtemp(join(tmpdir(),'selected-outside-'));
  const registry=new NativeCapabilityRegistry();
  try{
    await writeFile(join(root,'a.txt'),'text from owned file');
    await writeFile(join(outside,'secret.txt'),'never exposed');
    await symlink(outside,join(root,'escape'));
    const {services}=nativeServiceCatalog({registry,files:{root}});
    assert.equal(await services['fs.readText'](['a.txt'],identity),'text from owned file');
    assert.deepEqual(JSON.parse(await services['fs.list'](['.'],identity)),
      ['a.txt','escape']);
    await services['fs.writeText'](['a.txt','updated'],identity);
    assert.equal(await readFile(join(root,'a.txt'),'utf8'),'updated');
    await assert.rejects(services['fs.readText'](['../secret.txt'],identity),
      /escapes/);
    await assert.rejects(services['fs.readText'](['escape/secret.txt'],identity),
      /escapes/);
    const handle=await services['fs.openRead'](['a.txt'],identity);
    assert.deepEqual(registry.checkpoint().resources.map(x=>x.state),['lost']);
    await assert.rejects(services['fs.readChunk']([handle],{
      ...identity,realmId:'attacker'
    }),/cross-realm/);
    assert.equal(Buffer.from(await services['fs.readChunk']([handle],identity),
      'base64').toString('utf8'),'updated');
    assert.equal(await services['fs.readChunk']([handle],identity),'');
    await services['fs.close']([handle],identity);
    await assert.rejects(services['fs.readChunk']([handle],identity),/Unknown|revoked/);
  }finally{
    await registry.close();
    await rm(root,{recursive:true,force:true});
    await rm(outside,{recursive:true,force:true});
  }
});

test('HTTP capability checks origins and redirects without ambient refetch',async()=>{
  const received=[];
  const fetcher=async(url,opts)=>{
    received.push([url.href,opts.method]);
    if(url.pathname==='/redirect')return new Response('',{
      status:302,headers:{location:'https://evil.test/secret'}
    });
    return new Response('accepted',{status:202});
  };
  const registry=new NativeCapabilityRegistry();
  const http=httpServices({allowedOrigins:['https://allowed.test'],registry,fetcher});
  await assert.rejects(http['http.get'](['https://evil.test/a'],identity),/not granted/);
  await assert.rejects(http['http.get'](['https://allowed.test/redirect'],identity),
    /not granted/);
  assert.equal(received.length,1,'redirect may not refetch another origin');
  const handle=await http['http.post'](['https://allowed.test/api','hello'],identity);
  assert.equal(http['http.responseStatus']([handle],identity),202);
  assert.equal(await http['http.responseRead']([handle],identity),'accepted');
  await assert.rejects(http['http.responseRead']([handle],identity),/twice/);
  await http['http.responseClose']([handle],identity);
  assert.throws(()=>http['http.responseStatus']([handle],identity),/Unknown|revoked/);
  assert.equal(received.length,2);
});

test('scoped socket read/write observes a bounded network effect through its handle',async()=>{
  const server=createServer(socket=>socket.on('data',bytes=>socket.write(bytes)));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  const {services,registry}=nativeServiceCatalog({sockets:{
    allowedEndpoints:['127.0.0.1:'+port]}});
  try{
    await assert.rejects(services['net.connect'](['127.0.0.2',port],identity),
      /not granted/);
    const handle=await services['net.connect'](['127.0.0.1',port],identity);
    await services['net.write']([handle,'ping'],identity);
    assert.equal(Buffer.from(await services['net.read']([handle],identity),
      'base64').toString('utf8'),'ping');
    await services['net.close']([handle],identity);
    await assert.rejects(services['net.read']([handle],identity),/Unknown|revoked/);
  }finally{
    await registry.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
