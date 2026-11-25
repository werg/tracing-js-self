import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generatedCandidates,nearCloneHash,assignFrozenSplits,splitDiagnosticInputs,challengeCandidates,
  datasetCounts,sha256,censusCandidates,executionInputSignature} from '../src/training/tinker-benchmark.js';
import {independentDecode,independentGraph,independentNativeExecution,independentTranscriptMatches,independentConversationMatches} from '../src/training/tinker-independent.js';
import {encodeReadable,prepareTinkerTask,readableMessagesFromJournal} from '../src/training/tinker-execution.js';
import {boundedFuzzTask,verifyTaskBoundary,minimizeCounterexample,aggregateVerification,validateFuzzResumeRecord} from '../src/training/tinker-verification.js';

test('seeded corpus preserves template lineage and actual independently grouped denominators',()=>{
  const candidates=generatedCandidates({seed:17});
  assert.equal(candidates.length,1720);
  assert.deepEqual(candidates,generatedCandidates({seed:17}));
  const rows=assignFrozenSplits(candidates,{seed:17}),counts=datasetCounts(rows);
  assert.equal(counts.total.families,86);
  assert(counts.total.sourcePrograms>counts.total.independentComponents);
  assert(counts.total.independentComponents<=86);
  const seen=new Map();
  for(const row of rows){
    assert(row.metadata.features.length);
    for(const identity of [row.family,...row.metadata.lineage]){
      if(seen.has(identity))assert.equal(seen.get(identity),row.split,identity);
      seen.set(identity,row.split);
    }
  }
  for(const split of ['train','validation','test'])assert(counts.bySplit[split].independentComponents>0);
});

test('renaming identifiers or changing constants cannot produce independent source families',()=>{
  assert.equal(nearCloneHash('function run(a){return a+2;}'),nearCloneHash('function foo(value){return value+17;}'));
  assert.equal(nearCloneHash('function run(a){return a+2;}'),nearCloneHash('"use strict"; function foo(value){return value+17;}'));
  const rows=['function run(a){return a+2;}','function renamed(value){return value+17;}','function run(a){return a*2;}','function run(a){return a-2;}'].map((source,i)=>({
    id:'case-'+i,family:'family-'+i,source,args:[1],metadata:{template:'template-'+i,lineage:['near-clone:'+nearCloneHash(source)],features:[],tier:1}}));
  const split=assignFrozenSplits(rows);
  assert.equal(split[0].split,split[1].split);
  assert.equal(split[0].metadata.component,split[1].metadata.component);
});

test('familiar-input diagnostics are separated from training and main heldout sources',()=>{
  const rows=assignFrozenSplits(generatedCandidates()),{main,familiar,duplicateDiagnosticInputs}=splitDiagnosticInputs(rows);
  assert(familiar.length>0);
  assert.equal(main.length+familiar.length+duplicateDiagnosticInputs.length,rows.length);
  const trainedSources=new Set(main.filter(r=>r.split==='train').map(r=>r.source));
  const testSources=new Set(main.filter(r=>r.split==='test').map(r=>r.source));
  for(const row of familiar){assert(trainedSources.has(row.source));assert(!testSources.has(row.source));assert(row.metadata.diagnosticOnly);assert.equal(row.metadata.evaluationRole,'familiar_inputs');}
  const trainingKeys=new Set(main.filter(row=>row.split==='train').map(executionInputSignature));
  assert(familiar.every(row=>!trainingKeys.has(executionInputSignature(row))));
  assert.equal(new Set(familiar.map(executionInputSignature)).size,familiar.length);
  const challenge=challengeCandidates(main);
  assert(challenge.length>0);
  const heldoutFamilies=new Set(main.filter(r=>r.split==='test').map(r=>r.family));
  for(const row of challenge){assert(heldoutFamilies.has(row.family));assert.equal(row.metadata.evaluationRole,'challenge');assert(row.metadata.features.includes('longer-execution'));}
});

test('familiar-input exclusions detect duplicated training executions and preserve null observations',()=>{
  const source='function run(x){return x;}',make=(id,variant,value)=>({id,family:'f',source,args:[value],split:'train',
    fixture:{calls:[]},metadata:{template:'f',lineage:['f'],inputVariant:variant,features:[],tier:1}});
  const result=splitDiagnosticInputs([make('trained',1,2),make('duplicate',3,2),make('novel',3,4),make('duplicate-diagnostic',3,4)]);
  assert.equal(result.familiar.length,1);assert.equal(result.familiar[0].id,'novel-familiar');
  assert.deepEqual(result.duplicateDiagnosticInputs.map(row=>row.reason),['duplicates-training-execution','duplicates-familiar-diagnostic']);
  const base=make('base',1,2),withResult=result=>({...base,fixture:{calls:[{operation:'demo.readNumber',arguments:[],result}]}});
  assert.notEqual(executionInputSignature(withResult(null)),executionInputSignature(withResult({$js:'undefined'})));
});

test('fuzz resume records are bound to their generated task, source and complete verdict schema',async()=>{
  const task=boundedFuzzTask(17,0),record={index:0,taskDigest:sha256(task),ok:true,...await verifyTaskBoundary(task)};
  assert.equal(validateFuzzResumeRecord(record,{seed:17,count:2}),record);
  assert.throws(()=>validateFuzzResumeRecord(record,{seed:18,count:2}),/task digest/);
  for(const change of [{taskDigest:'0'.repeat(64)},{sourceHash:'0'.repeat(64)},{positiveControls:0},
    {independentChecked:false},{sourceVerified:false},{negativeControls:[]},{externalCalls:9},{ok:'true'}])
    assert.throws(()=>validateFuzzResumeRecord({...record,...change},{seed:17,count:2}));
});

test('fuzz CLI resumes only sealed, seed-bound evidence and archives incomplete tails',()=>{
  const directory=mkdtempSync(join(tmpdir(),'tinker-fuzz-resume-')),cli=fileURLToPath(new URL('../tools/tinker-benchmark.mjs',import.meta.url));
  const invoke=extra=>spawnSync(process.execPath,[cli,'fuzz','--seed','17','--count','2','--jobs','1','--output-dir',directory,...extra],
    {encoding:'utf8',timeout:30000,maxBuffer:2000000});
  try{
    const first=invoke([]);assert.equal(first.status,0,first.stderr);
    const log=join(directory,'cases.jsonl'),receiptPath=join(directory,'append-receipt.json'),original=readFileSync(log,'utf8');
    const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    writeFileSync(log,'{"unsealed":',{flag:'a'});
    const recovered=invoke(['--resume']);assert.equal(recovered.status,0,recovered.stderr);
    assert.equal(readFileSync(log,'utf8'),original);assert(readdirSync(directory).some(name=>name.startsWith('unreceipted-')));
    const changed=original.split('\n').filter(Boolean).map(JSON.parse);changed[0].taskDigest=sha256(boundedFuzzTask(18,changed[0].index));
    const bad=changed.map(row=>JSON.stringify(row)).join('\n')+'\n';writeFileSync(log,bad);
    const corrupt=invoke(['--resume']);assert.notEqual(corrupt.status,0);assert.match(corrupt.stderr,/sealed append receipt/);
    writeFileSync(receiptPath,JSON.stringify({...receipt,recordsSha256:sha256(bad)})+'\n');
    const foreign=invoke(['--resume']);assert.notEqual(foreign.status,0);assert.match(foreign.stderr,/task digest/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('independent snapshot catches alias copies, missing properties, sparse holes and negative zero',()=>{
  const shared={n:-0},sparse=new Array(3);sparse[1]=undefined;
  const data={arguments:[shared],value:{shared,sparse}};data.value.self=data.value;
  const decoded=independentDecode(encodeReadable(data));
  assert.equal(decoded.value.shared,decoded.arguments[0]);assert.equal(decoded.value.self,decoded.value);
  assert.deepEqual(independentGraph([data]),independentGraph([decoded]));
  const copied={arguments:[shared],value:{shared:{n:-0},sparse}};copied.value.self=copied.value;
  assert.notDeepEqual(independentGraph([data]),independentGraph([copied]));
  assert.notDeepEqual(independentGraph([-0]),independentGraph([0]));
  assert.notDeepEqual(independentGraph([sparse]),independentGraph([[undefined,undefined,undefined]]));
  assert.notDeepEqual(independentGraph([{x:undefined}]),independentGraph([{}]));
  assert.throws(()=>independentDecode({$js:'ref',path:'/missing'}),/reference/);
});

test('independent native audit rejects wrong observations and retains standard error scope',async()=>{
  const task={id:'audit',family:'audit',source:'function run(a){if(a<0)throw new TypeError("bad");return a;}',args:[-1]};
  const native=await independentNativeExecution(task);
  assert.equal(native.kind,'throw');
  assert(independentTranscriptMatches(native,[JSON.stringify({type:'complete',kind:'throw',arguments:[-1],value:{name:'TypeError',message:'bad'}})],task));
  await assert.rejects(independentNativeExecution({...task,source:'function run(){return host.readNumber("wrong");}',args:[],fixture:{calls:[{operation:'demo.readNumber',arguments:['right'],result:5}]}}),/differs/);
});

test('bounded adversarial verification rejects observable corruptions and accepts different narration',async()=>{
  const records=[];
  for(let index=0;index<16;index++)records.push({ok:true,...await verifyTaskBoundary(boundedFuzzTask(17,index))});
  const report=aggregateVerification(records);
  assert.equal(report.passed,16);assert.equal(report.independentChecks,16);assert.equal(report.positiveControls,48);
  for(const kind of ['wrong-result','wrong-completion-kind','wrong-input-mutation','alias-replaced-by-copy','negative-zero-conflated',
    'hole-filled-with-undefined','undefined-conflated','missing-effect','extra-effect','wrong-call-arguments','wrong-call-operation','reordered-effects','incomplete-execution'])
    assert(report.negativeControls[kind]>0,kind);
});

test('independent checker validates the actual displayed observation values, statuses and ordering',async()=>{
  const prepared=await prepareTinkerTask(boundedFuzzTask(17,4));
  const messages=readableMessagesFromJournal(prepared.bundle,prepared),native=await independentNativeExecution(prepared.task);
  assert(independentConversationMatches(native,messages,prepared.task));
  for(const suffix of ['{"status":"fulfilled","value":"forged"}','{"status":"rejected","value":1}']){
    const corrupted=structuredClone(messages),index=corrupted.findIndex((m,i)=>i>1&&m.role==='user');
    corrupted[index].content=corrupted[index].content.slice(0,corrupted[index].content.indexOf(': ')+2)+suffix;
    assert.equal(independentConversationMatches(native,corrupted,prepared.task),false);
  }
  const reordered=structuredClone(messages);[reordered[3],reordered[5]]=[reordered[5],reordered[3]];
  assert.equal(independentConversationMatches(native,reordered,prepared.task),false);
});

test('throwing generated cores do not declare unreachable trailing store observations',async()=>{
  const rows=generatedCandidates().filter(r=>r.metadata.sourceForm==='observed-branch'&&
    ['generated:throw-or-return','generated:standard-error-profile','generated:two-observations-finally'].includes(r.family));
  assert.equal(rows.length,12);
  let throws=0;
  for(const row of rows){const report=await verifyTaskBoundary(row);if(report.completeKind==='throw')throws++;}
  assert.equal(throws,6);
});

test('counterexample minimization preserves the caller-specified mismatch',async()=>{
  const task={source:'function run(a){const unused=2;return a;}',entry:'run',args:[99],id:'minimize',family:'minimize'};
  const minimized=await minimizeCounterexample(task,async candidate=>candidate.args[0]!==null&&candidate.source.includes('return'),{maxAttempts:12});
  assert(minimized.attempts<=12);assert(minimized.minimizedBytes<=minimized.originalBytes);assert(minimized.task.source.includes('return'));
});

test('file digests hash actual bytes and census keeps unsupported candidates in its denominator',()=>{
  assert.equal(sha256(Buffer.from('abc')),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const candidates=censusCandidates({streams:['production'],perFamily:1});
  assert(candidates.some(row=>row.source.includes('host.withCallback')));
  assert(candidates.some(row=>row.metadata.sourceOrigin==='production'));
  assert(candidates.every(row=>row.metadata.agentTaskSuccessVerified===false));
  assert.equal(new Set(candidates.map(row=>row.id)).size,candidates.length);
});
