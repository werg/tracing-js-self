#!/usr/bin/env node
import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {parse} from 'acorn';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';
import {verifyEffectfulTrainingCase,effectfulMetrics,checkCounterfactualPrefixes,requireNativeAdmission}
  from '../src/training/effectful-admit.js';
import {effectfulFamilySplit} from '../src/training/effectful-admit.js';
import {semanticRecipeFamilies,SEMANTIC_TASK_TEMPLATES,SEMANTIC_RECIPE_VERSION,SEMANTIC_RECIPE_NAME}
  from '../src/training/recipe-fixtures.js';
import {benchmarkFamiliesV1,BENCHMARK_ALGORITHMS,BENCHMARK_RECIPE_NAME,BENCHMARK_RECIPE_VERSION}
  from '../src/training/recipe-fixtures.js';
import {hostOperationContract} from '../src/host/operations.js';
import {verifyEffectfulSession} from '../src/training/effectful-session.js';
import {EXECUTION_VERSION,WITNESS_VERSION,CONTEXT_VERSION,HARNESS_PROFILE} from '../src/training/format.js';

const flags=new Map();for(let i=2;i<process.argv.length;i++){
  const name=process.argv[i];if(!name.startsWith('--'))throw new Error('Expected a named option');
  flags.set(name,name==='--require-native'?true:process.argv[++i]);
}
const output=resolve(flags.get('--out')??'artifacts/semantic-v4');mkdirSync(output,{recursive:true});
const megatoken=flags.get('--megatoken'),tokenizer=flags.get('--tokenizer'),python=flags.get('--python')??'python3';
const recipe=flags.get('--recipe')??'engineering';
if(!['engineering',SEMANTIC_RECIPE_NAME,BENCHMARK_RECIPE_NAME].includes(recipe))throw new Error('Unknown source recipe');
const jobs=Number(flags.get('--jobs')??1);
if(!Number.isSafeInteger(jobs)||jobs<1||jobs>8)throw new Error('--jobs must be between 1 and 8');
const representation=flags.get('--representation')??(recipe==='engineering'?null:'explicit');
if(representation!==null&&!['explicit','compact'].includes(representation))
  throw new Error('--representation must be explicit or compact');
const fixtures=representation?EFFECTFUL_ENGINEERING_FIXTURES
  .filter(fixture=>!fixture.projectionOptions?.representation||fixture.projectionOptions.representation===representation)
  .map(fixture=>({...fixture,projectionOptions:{...fixture.projectionOptions,representation}})):
  EFFECTFUL_ENGINEERING_FIXTURES;
if(flags.has('--require-native')&&(!megatoken||!tokenizer))
  throw new Error('--require-native requires --megatoken and --tokenizer');
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const normalizedSourceAst=source=>{
  const visit=value=>Array.isArray(value)?value.map(visit):value&&typeof value==='object'?
    Object.fromEntries(Object.entries(value).filter(([key])=>!['start','end','loc'].includes(key))
      .map(([key,item])=>[key,visit(item)])):value;
  return visit(parse(source,{ecmaVersion:'latest'}));
};
let serial=0;
const nativeConsumer=megatoken&&tokenizer?async exported=>{
  const input=join(output,'.native-input-'+(++serial)+'.json'),receipt=input+'.receipt';
  writeFileSync(input,JSON.stringify(exported)+'\n');
  await new Promise((resolveRun,reject)=>{
    const child=spawn(python,[resolve(megatoken,'scripts/admit_semantic_harness.py'),
      '--input',input,'--output',receipt,'--tokenizer-json',resolve(tokenizer)],{stdio:['ignore','ignore','pipe']});
    let error='';child.stderr.on('data',bytes=>{error=(error+bytes.toString()).slice(-8192);});
    child.once('error',reject);child.once('close',code=>code===0?resolveRun():reject(new Error(error||'Native admission failed')));
  });
  const result=JSON.parse(readFileSync(receipt,'utf8'));rmSync(input);rmSync(receipt);return result;
}:null;
const cases=[],exports=new Map(),counts={attempted:0,admitted:0,locally_verified:0};
function record(fixture,result){
  counts.attempted++;counts[result.status]=(counts[result.status]??0)+1;
  if(result.exported){
    const filename=fixture.id+'.json';
    writeFileSync(join(output,filename),JSON.stringify(result.exported)+'\n');exports.set(fixture.id,result.exported);
    cases.push({id:fixture.id,family:fixture.family,status:result.status,path:filename,
      ...(fixture.role?{role:fixture.role}:{}),
      representation:result.exported.sidecar.representation,
      split:result.exported.sidecar.split,episodeDigest:hash(result.exported.public),
      metrics:effectfulMetrics(result.exported)});
  }else cases.push({id:fixture.id,family:fixture.family,status:result.status,reason:result.reason});
  process.stderr.write(fixture.id+': '+result.status+(result.reason?' — '+result.reason:'')+'\n');
}
const tasks=[];
function sourceTask(fixture){tasks.push({fixture,run:()=>verifyEffectfulTrainingCase({
  ...fixture,nativeConsumer,producerRevision,taskId:fixture.id})});}
if(recipe==='engineering'){
  for(const fixture of fixtures)sourceTask(fixture);
  const fixture={id:'repeated-ingress',family:'async-counter'};
  tasks.push({fixture,run:()=>verifyEffectfulSession({cases:fixtures.slice(0,2),
    family:fixture.family,nativeConsumer,producerRevision})});
}else{
  const authoredFamilies=recipe===BENCHMARK_RECIPE_NAME?benchmarkFamiliesV1({representation}):
    semanticRecipeFamilies({representation});
  for(const family of authoredFamilies){
    sourceTask({...family.pure,role:'common-support'});
    sourceTask({...family.callbacks,role:'effectful'});
    const fixture={...family.repeated,role:'effectful'};
    tasks.push({fixture,run:()=>verifyEffectfulSession({...fixture,nativeConsumer,producerRevision})});
  }
}
// Collection tasks share no runtime or broker. Results are emitted in authored
// order, regardless of completion order or the requested worker count.
const results=Array(tasks.length);let next=0;
await Promise.all(Array.from({length:Math.min(jobs,tasks.length)},async()=>{
  for(;;){const index=next++;if(index>=tasks.length)return;
    try{results[index]=await tasks[index].run();}
    catch(error){results[index]={status:'collection_failed',reason:String(error.message??error)};}
  }
}));
for(const [index,task] of tasks.entries())record(task.fixture,results[index]);
const lifecycleInputs=[];
if(recipe!== 'engineering')for(const split of ['train','validation']){
  const parent=cases.find(item=>item.split===split&&exports.get(item.id)?.sidecar.collection);
  if(!parent)throw new Error('Authored recipe has no repeated source family in '+split);
  // This is the actual source-certified first activation, not a synthetic
  // trajectory. Its descendants keep the same family, source and frozen split.
  const child=structuredClone(exports.get(parent.id).sidecar.collection.components[0]);
  if(nativeConsumer){const receipt=await nativeConsumer(child);requireNativeAdmission(child,receipt);
    child.sidecar.nativeAdmission=receipt;child.sidecar.selectionOrigin='certified_teacher';child.sidecar.admission='admitted';}
  const fixture={id:parent.id.replace(/-repeated$/,'-child'),family:parent.family,role:'lifecycle-child'};
  record(fixture,{status:child.sidecar.admission,exported:child});
  lifecycleInputs.push({id:fixture.id,path:fixture.id+'.json',family:fixture.family,split,representation});
}
const counterfactuals=[];
for(const pair of [['counter-0','counter-1'],['branch-0','branch-1']])
  if(pair.every(id=>exports.has(id)))counterfactuals.push({pair,
    ...checkCounterfactualPrefixes(exports.get(pair[0]),exports.get(pair[1]))});
const recipeMetadata=recipe==='engineering'?{name:recipe}:recipe===BENCHMARK_RECIPE_NAME?{
  schema:BENCHMARK_RECIPE_VERSION,name:recipe,
  algorithms:BENCHMARK_ALGORITHMS.map(({name,body})=>({name,body,
    family:'semantic-benchmark-v1:'+name,ancestor:'source-algorithm-v1:'+name,
    split:effectfulFamilySplit('semantic-benchmark-v1:'+name),
    normalizedAstDigest:hash(normalizedSourceAst('function run(a,b){'+body+'}'))})),
  families:BENCHMARK_ALGORITHMS.map(({name})=>'semantic-benchmark-v1:'+name),
  splitCounts:Object.fromEntries(['train','validation','test'].map(split=>[split,
    BENCHMARK_ALGORITHMS.filter(({name})=>effectfulFamilySplit('semantic-benchmark-v1:'+name)===split).length])),
  normalizedAstDuplicateCount:BENCHMARK_ALGORITHMS.length-new Set(BENCHMARK_ALGORITHMS.map(({body})=>
    hash(normalizedSourceAst('function run(a,b){'+body+'}')))).size,
  normalizedAstAncestorDuplicateCount:BENCHMARK_ALGORITHMS.filter(({body})=>
    SEMANTIC_TASK_TEMPLATES.some(template=>hash(normalizedSourceAst('function run(a,b){return '+template.expression+';}'))===
      hash(normalizedSourceAst('function run(a,b){'+body+'}')))).length,
  retainEveryAuthoredFamily:true,lifecycleInputs,
  coverage:{familyCount:BENCHMARK_ALGORITHMS.length,
    splitCounts:Object.fromEntries(['train','validation','test'].map(split=>[split,
      BENCHMARK_ALGORITHMS.filter(({name})=>effectfulFamilySplit('semantic-benchmark-v1:'+name)===split).length])),
    sourceKinds:['pure','retained-callback-recovery','repeated-invocation','lifecycle-child'],
    familyRoles:Object.fromEntries(['common-support','effectful','lifecycle-child'].map(role=>[role,
      [...new Set(cases.filter(item=>item.role===role).map(item=>item.family))].length]))}
}:{schema:SEMANTIC_RECIPE_VERSION,name:recipe,
  templateDigest:hash(SEMANTIC_TASK_TEMPLATES),families:SEMANTIC_TASK_TEMPLATES.map(t=>'semantic-recipe:'+t.name),
  splitSeed:17,retainEveryAuthoredFamily:true,lifecycleInputs};
const manifest={schema:'semantic-corpus-manifest/4',execution:EXECUTION_VERSION,trace:WITNESS_VERSION,
  context:CONTEXT_VERSION,profile:HARNESS_PROFILE,producerRevision,
  representation:representation??'mixed',
  recipe:recipeMetadata,
  catalogDigest:hash(JSON.stringify(hostOperationContract(),null,2)+'\n'),
  counts,cases,counterfactuals,selectionOrigin:nativeConsumer?'certified_teacher':'owned-interpreter-teacher',
  evidenceKind:'deterministic-engineering',optimizerSteps:0,learnedSuccess:null};
writeFileSync(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(cases.some(item=>item.status!==(nativeConsumer?'admitted':'locally_verified')))
  process.exitCode=1;
