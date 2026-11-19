#!/usr/bin/env node
// Run paired source/input/effect cases through independent source qualification
// and candidate projection. Reports remain explicit about unavailable gates.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {SEMANTIC_EQUIVALENCE_FAMILIES,SEMANTIC_EQUIVALENCE_NEGATIVES} from '../fixtures/semantic-equivalence/families.js';
import {compareSemanticRepresentations} from '../src/semantic/evaluation.js';

const root=fileURLToPath(new URL('..',import.meta.url)),options=new Map();
for(let i=2;i<process.argv.length;i++){
  const key=process.argv[i];
  if(key==='--allow-dirty'&&!options.has(key)){options.set(key,true);continue;}
  if(!['--out','--baseline','--python','--consumer-root','--tokenizer-json','--tokenizer-policy'].includes(key)||
    options.has(key)||!process.argv[i+1]||process.argv[i+1].startsWith('--'))
    throw new Error('Usage: node tools/compare-semantic-representations.mjs --out DIRECTORY [--baseline FILE] '+
      '[--python PYTHON --consumer-root DIRECTORY --tokenizer-json FILE] [--tokenizer-policy FILE] [--allow-dirty]');
  options.set(key,process.argv[++i]);
}
if(!options.has('--out'))throw new Error('--out DIRECTORY is required');
const output=resolve(options.get('--out'));
if(existsSync(join(output,'comparison.json')))throw new Error('Choose a new output directory; comparison reports are immutable');
const baselinePath=resolve(options.get('--baseline')??join(root,'docs/evidence/semantic-algorithm-v7/baseline-v6.json'));
const baselineBytes=await readFile(baselinePath,'utf8'),baseline=JSON.parse(baselineBytes);
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
const implementationPaths=['src','tools','fixtures','contracts','package.json','package-lock.json'];
async function producerSnapshot(){
  const untracked=git('ls-files','--others','--exclude-standard','-z','--',...implementationPaths).split('\0').filter(Boolean);
  return {revision:git('rev-parse','HEAD'),tree:git('rev-parse','HEAD^{tree}'),
    trackedChanges:git('status','--porcelain','--untracked-files=no')!=='',
    implementationStatus:git('status','--porcelain','--untracked-files=all','--',...implementationPaths),
    implementationPatchDigest:createHash('sha256').update(git('diff','--binary','HEAD','--',...implementationPaths)).digest('hex'),
    untrackedImplementation:await Promise.all(untracked.map(async path=>({path,
      sha256:createHash('sha256').update(await readFile(join(root,path))).digest('hex')})))};
}
const producer=await producerSnapshot();
if(producer.implementationStatus&&!options.has('--allow-dirty'))
  throw new Error('Commit implementation files before measurement, or use --allow-dirty for an explicitly diagnostic run');
const tokenOptions=['--python','--consumer-root','--tokenizer-json'];
const tokenRequested=tokenOptions.some(key=>options.has(key))||options.has('--tokenizer-policy');
if(tokenRequested&&!tokenOptions.every(key=>options.has(key)))
  throw new Error('Qualified token metering requires --python, --consumer-root, and --tokenizer-json together');
let tokenizer=null,tokenizerPolicy=null,report;
if(tokenRequested){
  // This policy pins the exact codec/source assets. It never admits candidate
  // v7 bytes to the old native consumer or transfers its qualification.
  tokenizerPolicy=JSON.parse(await readFile(resolve(options.get('--tokenizer-policy')??
    join(root,'contracts/native-admission-policy-v6.json')),'utf8'));
  const {createAlgorithmTokenizer}=await import('../src/semantic/tokenizer.js');
  tokenizer=await createAlgorithmTokenizer({python:options.get('--python'),
    consumerRoot:resolve(options.get('--consumer-root')),tokenizerJson:resolve(options.get('--tokenizer-json')),
    policy:tokenizerPolicy});
}
try{
  report=await compareSemanticRepresentations({baseline,galleryFixtures:SEMANTIC_GALLERY_FIXTURES,
    families:SEMANTIC_EQUIVALENCE_FAMILIES,negatives:SEMANTIC_EQUIVALENCE_NEGATIVES,
    tokenizer,tokenizerPolicy,onProgress:row=>process.stderr.write(row.stage+' '+row.id+': '+row.status+'\n')});
  if(tokenizer)report.tokenizerQualification={identity:structuredClone(tokenizer.identity),
    qualification:structuredClone(tokenizer.qualification),nativeV7Admission:false};
}finally{if(tokenizer)await tokenizer.close();}
report.producer=producer;report.generatedAt=new Date().toISOString();
report.producerAtFinish=await producerSnapshot();
const changed=producer.revision!==report.producerAtFinish.revision||
  producer.implementationPatchDigest!==report.producerAtFinish.implementationPatchDigest||
  JSON.stringify(producer.untrackedImplementation)!==JSON.stringify(report.producerAtFinish.untrackedImplementation);
report.gates.producerIdentity={status:changed?'failed':producer.implementationStatus?'diagnostic-dirty':'passed',
  changedDuringMeasurement:changed};
if(changed){report.gates.engineering.status='failed';report.gates.engineering.producerChanged=true;}
report.baseline.file=baselinePath;report.baseline.sha256=createHash('sha256').update(baselineBytes).digest('hex');
report.environment={node:process.versions.node,platform:process.platform,arch:process.arch};
const historicalPath=join(root,'docs/evidence/semantic-target-gallery-v2/gallery.json');
if(existsSync(historicalPath)){
  const text=await readFile(historicalPath,'utf8'),historical=JSON.parse(text);
  report.historicalEvidence={path:'docs/evidence/semantic-target-gallery-v2/gallery.json',
    sha256:createHash('sha256').update(text).digest('hex'),representation:historical.representation,
    totals:historical.totals,authority:'Original artifact counts only; no qualification or token count is transferred to the candidate'};
}
const clean=value=>String(value??'unavailable').replaceAll('|','\\|').replaceAll('\n',' ');
const text=['# Paired semantic representation comparison','',
  'Producer: `'+producer.revision+'`. Tracked working-tree changes: **'+producer.trackedChanges+'**.','',
  'Engineering checks: **'+report.gates.engineering.status+'**. Promotion: **not qualified**. '+
  'Native consumer, native serving/token costs, and comprehension remain separate gates.','',
  '## Unchanged gallery','',
  '| Case | Disposition | Detailed target bytes | Current target bytes | Delta | Frozen targets |',
  '| --- | --- | ---: | ---: | ---: | --- |',
  ...report.gallery.rows.map(row=>'| '+[row.id,row.disposition,row.costs.detailed?.bytes.generated,
    row.costs.current?.bytes.generated,row.delta.generatedBytes,row.frozenBaseline?.status].map(clean).join(' | ')+' |'),'',
  '## Equivalence families','',
  '| Family | Variants | Input cases | Verified executions / declared | Converged groups / declared |',
  '| --- | ---: | ---: | --- | --- |',
  ...report.families.map(row=>'| '+[row.id,row.variants,row.inputCases,
    row.convergence.supportedExecutions+' / '+row.expectedExecutions,
    row.convergence.converged+' / '+row.convergence.groups].map(clean).join(' | ')+' |'),'',
  '## Negative cases','',
  'Passed '+report.negatives.passed+' / '+report.negatives.cases+'. False merges: '+report.negatives.falseMerges+
    '. Unsafe profile admissions: '+report.negatives.unsafeAdmissions+'.','',
  '| Case | Stage | Result | Reason |','| --- | --- | --- | --- |',
  ...report.negatives.rows.map(row=>'| '+[row.id,row.stage,row.status,row.reason??'Expected distinction/refusal preserved'].map(clean).join(' | ')+' |'),'',
  '## Measurement boundaries','',
  'The JSON report retains every case, source/input identity, exact target, refusal/failure, byte category, '+
  'distribution, and actual supplied JS context snapshot costs. JSONL envelope accounting is not native model framing. '+
  'Token fields remain null without an executed qualified tokenizer. Historical token counts stay separate.','',
  ...report.limitations.map(value=>'- '+value),''];
await mkdir(output,{recursive:true});
await writeFile(join(output,'comparison.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(join(output,'comparison.md'),text.join('\n'));
process.stdout.write(JSON.stringify({report:join(output,'comparison.json'),engineering:report.gates.engineering,
  promotion:report.gates.promotion.status,cases:report.totals.cases})+'\n');
if(report.gates.engineering.status!=='passed')process.exitCode=1;
