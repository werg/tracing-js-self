import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('binary metadata remains independently checked without the detached intrinsic getter',()=>{
  // Load the production observer after removing the newer intrinsic in an
  // isolated process, so this exercises the actual Node 20 capability boundary.
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import vm from 'node:vm';
    delete ArrayBuffer.prototype.detached;
    const {createMemoryObservationAdapterV8}=await import(process.argv[1]);
    const {createNativeProtocolMetadata,compareProtocolMetadata}=await import(process.argv[2]);
    const adapter=createMemoryObservationAdapterV8();
    const capture=createNativeProtocolMetadata({adapters:[adapter.metadataAdapter]});
    const observe=buffer=>capture.observe('0:0','return',buffer);
    const metadata=receipt=>receipt.objects.at(-1).annotations[0].data;
    const empty=new ArrayBuffer(0);
    assert.deepEqual(metadata(observe(empty)),{
      byteLength:0,maxByteLength:0,resizable:false,detached:false,bytes:[]});
    const buffer=new ArrayBuffer(4),view=new Uint8Array(buffer);
    view[1]=17;
    const before=observe(buffer);
    assert.deepEqual(metadata(before),{
      byteLength:4,maxByteLength:4,resizable:false,detached:false,bytes:[0,17,0,0]});
    view[1]=99;
    const after=observe(buffer);
    assert.equal(compareProtocolMetadata([before],[after]).status,'mismatch');
    assert.deepEqual(metadata(after).bytes,[0,99,0,0]);
    // Guest properties cannot replace the intrinsic byte/attachment evidence.
    let reads=0;
    const hostile=new ArrayBuffer(2);
    for(const key of ['byteLength','maxByteLength','resizable','detached'])
      Object.defineProperty(hostile,key,{get(){reads++;throw new Error('guest getter');}});
    const hostileCapture=createNativeProtocolMetadata({adapters:[adapter.metadataAdapter]});
    const hostileReceipt=hostileCapture.observe('1:1','return',hostile);
    assert.deepEqual(hostileReceipt.objects[0].annotations[0].data,{
      byteLength:2,maxByteLength:2,resizable:false,detached:false,bytes:[0,0]});
    assert.equal(reads,0);
    const realm=vm.createContext({});
    adapter.initializeRealm(expression=>vm.runInContext(expression,realm));
    const foreign=vm.runInContext('new Uint8Array([3,5]).buffer',realm);
    const foreignCapture=createNativeProtocolMetadata({adapters:[adapter.metadataAdapter]});
    assert.deepEqual(metadata(foreignCapture.observe('2:2','return',foreign)),{
      byteLength:2,maxByteLength:2,resizable:false,detached:false,bytes:[3,5]});
    for(const length of [0,4]){
      const detached=new ArrayBuffer(length);
      structuredClone(detached,{transfer:[detached]});
      assert.throws(()=>createNativeProtocolMetadata({
        initialValues:[detached],adapters:[adapter.metadataAdapter]}),TypeError);
    }
    assert.throws(()=>createNativeProtocolMetadata({
      initialValues:[new ArrayBuffer(1025)],adapters:[adapter.metadataAdapter]}),/byte bound/);
    process.stdout.write('checked');
  `,new URL('../src/semantic/protocol-memory-observation-v8.js',import.meta.url).href,
  new URL('../src/semantic/protocol-metadata-v8.js',import.meta.url).href],
  {encoding:'utf8',timeout:20000});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'checked');
});
