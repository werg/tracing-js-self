import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {referenceCommand,referenceEnvironment,referenceIsolationMode}
  from '../src/corpus/reference-isolation.mjs';
import {verifyEffectfulTrainingCase,recheckEffectfulAdmission} from '../src/training/effectful-admit.js';

function available(t){
  if(process.platform!=='linux'){t.skip('Linux namespaces are required');return false;}
  const probe=spawnSync('/usr/bin/unshare',['--user','--map-root-user','--mount','--net','--pid','--fork','true'],
    {encoding:'utf8',timeout:5000});
  if(probe.status!==0){t.skip('Unprivileged namespaces unavailable: '+(probe.error?.message??probe.stderr.trim()));return false;}
  return true;
}
function directory(t){
  const path=mkdtempSync(join(tmpdir(),'reference-confinement-'));
  t.after(()=>rmSync(path,{force:true,recursive:true}));return path;
}
test('reference environments remove credentials, injection flags and network proxy settings',()=>{
  const names=['REFERENCE_SECRET','NODE_OPTIONS','HTTPS_PROXY'];
  const before=Object.fromEntries(names.map(key=>[key,process.env[key]]));
  try{
    for(const key of names)process.env[key]='test-do-not-forward';
    const environment=referenceEnvironment();
    for(const key of names)assert.equal(environment[key],undefined);
  }finally{for(const key of names)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  assert.throws(()=>referenceCommand(import.meta.filename,{timeoutMs:100,isolation:'invalid'}),/unavailable/);
});

test('OS confinement survives direct access to Node filesystem, networking and process APIs',t=>{
  if(!available(t))return;
  const temporary=directory(t),sentinel=join(temporary,'host-only.txt'),worker=join(temporary,'probe.mjs');
  writeFileSync(sentinel,'host-only sentinel');
  writeFileSync(worker,`
    import fs from 'node:fs';
    import net from 'node:net';
    import {spawnSync} from 'node:child_process';
    const attempt=operation=>{try{operation();return 'unexpected success';}catch(error){return error.code;}};
    const hostRead=attempt(()=>fs.readFileSync(${JSON.stringify(sentinel)}));
    const sourceWrite=attempt(()=>fs.writeFileSync('/app/package.json','changed'));
    const historyRead=attempt(()=>fs.readdirSync('/app/.git'));
    fs.writeFileSync('/tmp/private','private temporary bytes');
    const child=spawnSync('/bin/node',['--version']);
    const server=net.createServer();
    const network=await new Promise(resolve=>{server.once('error',error=>resolve(error.code));
      server.listen(23456,'127.0.0.1',()=>{server.close();resolve('unexpected success');});});
    console.log(JSON.stringify({pid:process.pid,hostRead,sourceWrite,historyRead,network,
      child:child.error?.code??child.status,environment:process.env,
      temporary:fs.readFileSync('/tmp/private','utf8'),
      status:fs.readFileSync('/proc/self/status','utf8'),limits:fs.readFileSync('/proc/self/limits','utf8')}));
  `);
  const specification=referenceCommand(worker,{timeoutMs:15000,isolation:'linux-namespace'});
  let child;
  try{child=spawnSync(specification.command,specification.args,
    {encoding:'utf8',env:specification.env,timeout:15000,maxBuffer:65536});}
  finally{specification.cleanup();}
  assert.equal(child.status,0,child.stderr||child.error?.message);
  const result=JSON.parse(child.stdout);
  assert.equal(result.pid,1);
  assert.equal(result.hostRead,'ENOENT');assert.equal(result.historyRead,'ENOENT');
  assert.equal(result.sourceWrite,'EROFS');assert.equal(result.child,'EPERM');assert.equal(result.network,'EPERM');
  assert.equal(result.temporary,'private temporary bytes');
  assert.deepEqual(Object.keys(result.environment).sort(),['LANG','LC_ALL','PATH','TMPDIR','TZ']);
  for(const field of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])assert.match(result.status,new RegExp(field+':\\s+0+\\n'));
  assert.match(result.status,/NoNewPrivs:\s+1\n/);assert.match(result.status,/Seccomp:\s+2\n/);
  assert.match(result.limits,/Max address space\s+1073741824\s+1073741824/);
  assert.match(result.limits,/Max file size\s+67108864\s+67108864/);
  assert.match(result.limits,/Max open files\s+64\s+64/);
  assert.match(result.limits,/Max cpu time\s+15\s+15/);
  assert.equal(readFileSync(sentinel,'utf8'),'host-only sentinel');
});

test('isolated original and instrumented references pass the source gate and bind the executed policy',async t=>{
  if(!available(t))return;
  const previous=process.env.TRACING_REFERENCE_ISOLATION;
  try{
    process.env.TRACING_REFERENCE_ISOLATION='linux-namespace';
    const result=await verifyEffectfulTrainingCase({
      source:'"use strict"; function run(x){if(x>0)return [x,x+1];throw 7;}',
      entry:'run',args:[2],fixture:{calls:[]},family:'isolated-reference-regression',timeoutMs:15000});
    assert.equal(result.status,'locally_verified',result.reason);
    assert.equal(result.exported.sidecar.environment.referenceIsolation.mode,'linux-namespace');
    assert.equal((await recheckEffectfulAdmission(result.exported,{requireAdmitted:false,timeoutMs:15000})).identityValidated,true);
    process.env.TRACING_REFERENCE_ISOLATION='trusted-process';
    await assert.rejects(recheckEffectfulAdmission(result.exported,{requireAdmitted:false}),/environment/);
    process.env.TRACING_REFERENCE_ISOLATION='invalid';
    assert.throws(referenceIsolationMode,/Unknown/);
  }finally{if(previous===undefined)delete process.env.TRACING_REFERENCE_ISOLATION;else process.env.TRACING_REFERENCE_ISOLATION=previous;}
});
