import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRuntime} from './producer-promise-adoption/src/runtime.js';
import {compileProtocolSourceV8} from './producer-promise-adoption/src/semantic/protocol-source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase,recheckProtocolRegionEvidence} from './producer-promise-adoption/src/semantic/protocol-source-v8.js';
import {RegionExecutionHarness} from './producer-promise-adoption/src/semantic/region-harness.js';
import {sharedRegionState} from './producer-promise-adoption/src/semantic/regions.js';

const root='/workspace/scratch/05d92519587f',producer=root+'/producer-promise-adoption',
  native=root+'/native-promise-adoption-qualified-03a9',python=root+'/native-recovery-venv/bin/python';
const mutationSource=(setup,mutation)=>'"use strict";async function target(){return 1;}async function run(){let order="";const p=target();'+setup+mutation+
  'async function outer(){return p;}const adopted=outer();adopted.then(value=>{order+=value;});await adopted;return order;}';
const getter='{get:function(){order+="g";return function(resolve){order+="t";resolve(2);};}}',
  setter='function(resolve){order+="t";resolve(2);}';
const rows=[
  ['positive-async-owned-return','"use strict";async function target(){return 1;}async function run(){const p=target();async function outer(){return p;}return await outer();}',false],
  ['external-published-literal-own-then-accessor',mutationSource('','Object.defineProperty(p,"then",'+getter+');'),true],
  ['computed-binding-own-then-accessor',mutationSource('const key="then";','Object.defineProperty(p,key,'+getter+');'),true],
  ['computed-expression-own-then-accessor',mutationSource('','Object.defineProperty(p,"th"+"en",'+getter+');'),true],
  ['literal-own-then-assignment',mutationSource('','p.then='+setter+';'),true],
  ['computed-binding-own-then-assignment',mutationSource('const key="then";','p[key]='+setter+';'),true],
  ['computed-expression-own-then-assignment',mutationSource('','p["th"+"en"]='+setter+';'),true],
  ['aliased-promise-own-then-accessor',mutationSource('const alias=p;','Object.defineProperty(alias,"then",'+getter+');'),true],
  ['aliased-object-defineProperty',mutationSource('const O=Object;','O.defineProperty(p,"then",'+getter+');'),true],
  ['aliased-method-defineProperty',mutationSource('const define=Object.defineProperty;','define(p,"then",'+getter+');'),true],
  ['destructured-method-defineProperty',mutationSource('const {defineProperty:define}=Object;','define(p,"then",'+getter+');'),true],
  ['computed-object-assign-then',mutationSource('const key="then";','Object.assign(p,{[key]:'+setter+'});'),true],
  ['computed-reflect-set-then',mutationSource('const key="then";','Reflect.set(p,key,'+setter+');'),true],
  ['computed-defineProperties-then',mutationSource('const key="then";','Object.defineProperties(p,{[key]:'+getter+'});'),true],
  ['aliased-setPrototypeOf',mutationSource('const set=Object.setPrototypeOf;','set(p,{then:'+setter+'});'),true],
  ['prototype-computed-then','"use strict";async function h(){return Promise.resolve(1);}async function run(){let order="";const original=Promise.prototype.then;const key="then";Promise.prototype[key]=function(resolve,reject){order+="t";return original.call(this,resolve,reject);};const adopted=h();await adopted;return order;}',true],
  ['aliased-promise-resolve-override','"use strict";async function h(){return Promise.resolve(1);}async function run(){const P=Promise;P.resolve=function(value){return {then:function(resolve){resolve(value+1);}};};return await h();}',true],
  ['shadowed-promise-resolve','"use strict";async function h(Promise){return Promise.resolve(1);}async function run(){return await h({resolve:function(value){return Promise.resolve(value+1);}});}',true],
  ['positive-unrelated-object-write','"use strict";async function h(o){o.x=2;return Promise.resolve(o.x);}async function run(){return await h({x:1});}',false]
];
const git=(cwd,arg)=>{const r=spawnSync('git',arg,{cwd,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();};
const identities={producer:{localRevision:git(producer,['rev-parse','HEAD']),tree:git(producer,['rev-parse','HEAD^{tree}']),status:git(producer,['status','--porcelain']),publishedRevision:'90756c533ee04afc2a41d8890d979e94456f9243'},
  native:{revision:git(native,['rev-parse','HEAD']),tree:git(native,['rev-parse','HEAD^{tree}']),status:git(native,['status','--porcelain'])}};
if(identities.producer.tree!=='1652a93ff2e99d02a962d95f0c856317c02bb2fe'||identities.producer.status||identities.native.revision!=='03a9e33866207b5b0c4105297c6050dacadcf85f'||identities.native.status)throw Error('Unfrozen probe source');
const evidence={schema:'promise-then-lookup-frozen-review/1',identities,externalSourceRevision:'7fe5a9d57fbf456f0165534f089116b4b5db7279',
  note:'Literal accessor source follows the published external test. Derived computed/alias variants are separately labeled; no later unpublished exact regression is assumed.',rows:[]};
for(const [name,source,negative]of rows){
  const row={name,source,sourceSha256:createHash('sha256').update(source).digest('hex'),expectedRefusal:negative};
  const original=spawnSync(process.execPath,['-e','const originalThen=Promise.prototype.then;'+source+
    ';originalThen.call(run(),value=>process.stdout.write(JSON.stringify({kind:"return",value})),error=>process.stdout.write(JSON.stringify({kind:"throw",name:error?.name,message:error?.message})));'],
    {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
  row.original={exit:original.status,stdout:original.stdout,stderr:original.stderr,error:original.error?.message??null};
  if(original.status===0)try{row.original.outcome=JSON.parse(original.stdout);}catch{}
  try{
    const runtime=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});row.ownedDrive=runtime.drive();
    const projected=compileProtocolSourceV8(runtime.exportRun());
    row.directProjection={accepted:true,outcome:projected.outcome,protocolRecords:projected.claims.filter(r=>r.kind==='protocol').length};
  }catch(error){row.directProjection={accepted:false,error:error.message,category:error.category??null};}
  const result=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'then-lookup-frozen:'+name});
  row.sourceAdmission={exported:Boolean(result.exported),status:result.status,phase:result.phase??null,category:result.category??null,reason:result.reason??null};
  if(result.exported){
    const checked=await recheckProtocolRegionEvidence(result.exported),replay=RegionExecutionHarness.replay(result.exported);
    row.sourceAdmission.sourceValidated=checked.sourceValidated;row.sourceAdmission.completion=replay.controller.completion;
    const packet={artifact:result.exported,state:sharedRegionState(replay.controller)},script=`import json,sys
from megatoken.data.native_v8 import validate_v8_artifact,_replay_shared_state
p=json.load(sys.stdin);a=p['artifact'];r=validate_v8_artifact(a)
assert all(r['checks'][k]=='passed' for k in ['replay','contexts','continuation'])
s=_replay_shared_state(a['public']['timeline'],a['contexts'],{},roundtrip=True,boundary_invocation='invocation1')['state']
assert s==p['state']
print(json.dumps(r))
`;
    const nativeResult=spawnSync(python,['-c',script],{cwd:native,env:{...process.env,PYTHONPATH:native+'/src',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1'},input:JSON.stringify(packet),encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
    row.native={exit:nativeResult.status,stderr:nativeResult.stderr,error:nativeResult.error?.message??null};
    if(nativeResult.status===0)row.native.receipt=JSON.parse(nativeResult.stdout);
  }
  evidence.rows.push(row);console.log(JSON.stringify({name,original:row.original.outcome,direct:row.directProjection,source:row.sourceAdmission,nativeExit:row.native?.exit}));
}
evidence.finalStatus={producer:git(producer,['status','--porcelain']),native:git(native,['status','--porcelain'])};
evidence.counts={cases:evidence.rows.length,negativeCases:evidence.rows.filter(r=>r.expectedRefusal).length,negativeSourceRefusals:evidence.rows.filter(r=>r.expectedRefusal&&!r.sourceAdmission.exported).length,
  negativeDirectProjectionAccepted:evidence.rows.filter(r=>r.expectedRefusal&&r.directProjection.accepted).length,positiveNativePassed:evidence.rows.filter(r=>!r.expectedRefusal&&r.native?.exit===0).length};
writeFileSync(root+'/promise-then-lookup-frozen-probe.json',JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence.counts));
if(evidence.rows.some(r=>r.expectedRefusal?r.sourceAdmission.exported:!r.sourceAdmission.exported||r.native?.exit!==0)||evidence.finalStatus.producer||evidence.finalStatus.native)process.exitCode=1;
