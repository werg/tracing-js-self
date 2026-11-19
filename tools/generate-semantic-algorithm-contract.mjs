#!/usr/bin/env node
// Deterministic candidate contract and decoder corpus. A generated contract is
// a shared specification, not qualification of an independent native consumer.
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ALGORITHM_VERSION,ALGORITHM_PROFILE,ALGORITHM_LIMITS,ALGORITHM_INPUT_TYPES,
  validateAlgorithm,stableAlgorithmJSON} from '../src/semantic/ir.js';
import {OBSERVATION_CONTRACT_VERSION} from '../src/semantic/observables.js';
import {TRANSFORMATION_RECEIPT_VERSION} from '../src/semantic/provenance.js';
import {OPERATION_REGISTRY,evaluateTerm,evaluateAlgorithm} from '../src/semantic/operations.js';
import {ALGORITHM_PROGRAM_VERSION,ALGORITHM_EXECUTION_VERSION,ALGORITHM_CONTEXT_VERSION,
  ALGORITHM_CONTINUATION_VERSION} from '../src/semantic/program.js';
import {ALGORITHM_TRACE_VERSION,ALGORITHM_TRACE_MAX_BYTES,ALGORITHM_RECORD_KINDS,
  encodeAlgorithmRecord,decodeAlgorithmRecord,algorithmTraceGrammar} from '../src/semantic/trace-codec.js';

const digest=value=>createHash('sha256').update(stableAlgorithmJSON(value)).digest('hex');
const literal=value=>({op:'literal',value:['num',value]});
export function buildSemanticAlgorithmContract(){
  const definition={schema:'semantic-algorithm-contract/1',status:'candidate',
    versions:{core:ALGORITHM_VERSION,profile:ALGORITHM_PROFILE,observation:OBSERVATION_CONTRACT_VERSION,
      receipt:TRANSFORMATION_RECEIPT_VERSION,program:ALGORITHM_PROGRAM_VERSION,trace:ALGORITHM_TRACE_VERSION,
      execution:ALGORITHM_EXECUTION_VERSION,context:ALGORITHM_CONTEXT_VERSION,continuation:ALGORITHM_CONTINUATION_VERSION},
    core:{fields:['schema','profile','inputs','steps'],inputFields:['id','type'],inputTypes:ALGORITHM_INPUT_TYPES,
      steps:{compute:['kind','id','term'],request:['kind','id','boundary','operation','arguments'],
        observe:['kind','id','request'],write:['kind','object','key','value','present'],
        return:['kind','value'],throw:['kind','value'],suspend:['kind','requests','live']}},
    terms:{literal:['op','value'],input:['op','id'],ref:['op','id'],project:['op','object','key'],
      operation:['op','args'],fold_left:['op','input','initial','step','order','profile']},
    operations:OPERATION_REGISTRY,
    fold:{step:'add',order:'ascending',profile:'dense-number-array/1',
      inputs:'Ordinary dense arrays with only length and finite numeric elements; at most 128 items',
      semantics:'Binary64 left-to-right accumulation; no reassociation; preserve overflow and signed zero'},
    records:{kinds:ALGORITHM_RECORD_KINDS,fields:{compute:['kind','id','term','result'],
      request:['kind','id','boundary','operation','arguments'],
      observe:{completed:['kind','request','id','status'],fulfilled:['kind','request','id','status','value'],
        rejected:['kind','request','id','status','value']},
      write:['kind','object','key','value','present'],return:['kind','value'],throw:['kind','value'],
      suspend:['kind','requests','live']},extraFields:'rejected',canonicality:'parse then re-encode must equal exact original bytes'},
    values:{tags:['undefined','null','bool','str','num','bigint','ref'],specialNumbers:['-0','NaN','+Infinity','-Infinity'],
      bigint:'Canonical decimal string with no leading zero or negative zero',
      identityPattern:'^[A-Za-z_$][A-Za-z0-9_$:-]*$',
      dependencySpelling:{input:'$id',value:'%id',object:'@id'}},
    limits:{...ALGORITHM_LIMITS,recordBytes:ALGORITHM_TRACE_MAX_BYTES,arguments:128},
    context:{required:['schema','definition','input','invocationId','state','visibleThrough','prefixDigest'],
      optional:['program','inputGraph'],definitionIdentity:'program.definitionDigest',
      inputIdentity:'sha256(stableAlgorithmJSON(inputGraph))',
      publication:'Publish immutable program and input graph before referencing their identities',
      inputScope:'One immutable input graph identity per invocation; live semantic values are separate state',
      stateFields:['cursor','values','symbols','pending','abrupt','completion','firstViolation'],
      costBoundary:'Actual JS context snapshots; native framing and retrieval require separate measurement'},
    authority:{generated:ALGORITHM_RECORD_KINDS.filter(kind=>kind!=='observe'),observed:['observe'],
      observationLoss:0,capabilityRouting:'Immutable certified semantic boundary and committed arguments',
      payload:'Derived by host codec; absent from generated requests',
      unsupported:'Explicit refusal or separately labeled detailed artifact; no relabeling',
      nativeQualification:'Requires the actual independent companion and pinned tokenizer; fixtures alone do not qualify it'},
    grammar:{generated:algorithmTraceGrammar({role:'generated'}),observed:algorithmTraceGrammar({role:'observed'}),
      scope:'Syntax-only; strict value, binding, budget, capability, and causal checks still required'}};
  const records=[];
  for(const [op,spec] of Object.entries(OPERATION_REGISTRY)){
    const term={op,args:Array.from({length:spec.arity},(_,i)=>literal(i+1))};
    records.push({kind:'compute',id:'v0',term,result:evaluateTerm(term)});
  }
  records.push(
    {kind:'compute',id:'v0',term:{op:'fold_left',input:{op:'input',id:'a0'},initial:literal(0),
      step:'add',order:'ascending',profile:'dense-number-array/1'},result:['num',9]},
    {kind:'compute',id:'v0',term:{op:'project',object:{op:'input',id:'a0'},key:'n'},result:['undefined']},
    {kind:'request',id:'r0',boundary:'b0',operation:'demo.readAsync',arguments:[['str','counter']]},
    {kind:'request',id:'r1',boundary:'b1',operation:'demo.store',arguments:[['str','counter'],['num',8]]},
    {kind:'observe',request:'r0',id:'v0',status:'fulfilled',value:['num',7]},
    {kind:'observe',request:'r0',id:'v0',status:'rejected',value:['str','missing']},
    {kind:'observe',request:'r1',id:'v2',status:'completed'},
    {kind:'observe',request:'r1',id:'v2',status:'fulfilled',value:['undefined']},
    {kind:'write',object:['ref','o1'],key:'n',value:['num',2],present:true},
    {kind:'write',object:['ref','o1'],key:'n',value:['undefined'],present:false},
    {kind:'suspend',requests:['r0'],live:['v0']},
    {kind:'return',value:['num',8]}, {kind:'throw',value:['str','missing']}
  );
  for(const value of [['undefined'],['null'],['bool',true],['str','a\n"é'],['num','-0'],['num','NaN'],
    ['num','+Infinity'],['num','-Infinity'],['num',1e21],['bigint','12345678901234567890'],['ref','object:1']])
    records.push({kind:'return',value});
  const canonical=records.map(record=>({record,line:encodeAlgorithmRecord(record),
    role:record.kind==='observe'?'observed':'generated'}));
  for(const fixture of canonical){
    if(stableAlgorithmJSON(decodeAlgorithmRecord(fixture.line,{role:fixture.role}))!==stableAlgorithmJSON(fixture.record))
      throw new Error('Canonical algorithm fixture changed');
  }
  const invalid=[
    'return 1.0','return 01','return 1e0','return -0n','return 1e999','return "\\u0061"',
    'evaluate run(1) => 2','compute (a + 1) => 2','return {"value":["num",1]}',
    'v0 = add(1) => 1','v0 = add(1,2) => 3','v0 = unknown(1) => 1',
    'v0 = fold_left($a0, 0, multiply) => 0','observe r0 as v0: pending 1',
    'observe r0 as v0: completed undefined','suspend [] live []','suspend [r0, r0] live []',
    'request r0 b0: demo.store("counter", 8) payload ["counter",8]','return 1\nreturn 2'
  ];
  for(const line of invalid){let refused=false;try{decodeAlgorithmRecord(line);}catch{refused=true;}
    if(!refused)throw new Error('Invalid decoder fixture accepted: '+line);}
  const pure={schema:ALGORITHM_VERSION,profile:ALGORITHM_PROFILE,inputs:[{id:'a0',type:'number'}],steps:[
    {kind:'compute',id:'v0',term:{op:'add',args:[{op:'input',id:'a0'},literal(1)]}},
    {kind:'return',value:{op:'ref',id:'v0'}}]};
  const badCore=structuredClone(pure);badCore.steps[0].term.args[0].id='future';
  validateAlgorithm(pure);
  let rejected=false;try{validateAlgorithm(badCore);}catch{rejected=true;}
  if(!rejected)throw new Error('Invalid dependency fixture accepted');
  const examples=[{core:pure,arguments:[['num',4]],expectedCompletion:{kind:'return',value:['num',5]}}];
  for(const example of examples)if(stableAlgorithmJSON(evaluateAlgorithm(example.core,example.arguments).completion)!==
    stableAlgorithmJSON(example.expectedCompletion))throw new Error('Semantic contract example disagrees');
  const fixtures={scope:'Decoder fixtures test typed parsing; semantic examples separately test evaluation',
    canonical,invalid,invalidGenerated:[canonical.find(row=>row.record.kind==='observe').line],
    invalidObserved:[canonical.find(row=>row.record.kind==='compute').line],
    cores:{valid:[pure],invalid:[badCore]},semanticExamples:examples};
  return {definition,digest:digest(definition),fixtureDigest:digest(fixtures),fixtures};
}

export async function generateSemanticAlgorithmContract({check=false,destination=new URL('../contracts/semantic-algorithm-v7.json',import.meta.url)}={}){
  const artifact=buildSemanticAlgorithmContract(),content=JSON.stringify(artifact,null,2)+'\n';
  if(check){if(await readFile(destination,'utf8')!==content)throw new Error('Algorithm contract needs regeneration');}
  else await writeFile(destination,content);
  return {schema:artifact.definition.schema,digest:artifact.digest,fixtureDigest:artifact.fixtureDigest};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.slice(2).some(arg=>arg!=='--check')||process.argv.filter(arg=>arg==='--check').length>1)
    throw new Error('Usage: node tools/generate-semantic-algorithm-contract.mjs [--check]');
  process.stdout.write(JSON.stringify(await generateSemanticAlgorithmContract({check:process.argv.includes('--check')}))+'\n');
}
