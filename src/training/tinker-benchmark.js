// Reproducible task construction. Source families are assigned before admission,
// expansion or splitting; refusals remain in the candidate census.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'acorn';
import {SEMANTIC_TASK_TEMPLATES, BENCHMARK_ALGORITHMS, semanticRecipeFamilies, benchmarkFamiliesV1} from './recipe-fixtures.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from './engineering-fixtures.js';
import {trustedRealSourceCases} from '../corpus/trusted-source-candidates.mjs';
import {encodeReadable, normalizedSourceHash} from './tinker-execution.js';

export const BENCHMARK_SCHEMA = 'tinker-generalization-corpus/1';
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || ArrayBuffer.isView(value) ? value : JSON.stringify(value)).digest('hex');
export function seededRandom(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw TypeError('seed must be uint32');
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

// Conservative lexical near-clone fingerprint. Renaming identifiers or changing
// literal values never creates an independent family. This is an extra union
// edge, not a claim to decide semantic equivalence of arbitrary JavaScript.
export function nearCloneHash(source) {
  const clean = node => {
    // Admission enforces strict mode for every task. An already-present strict
    // directive must not defeat clone grouping after a rename/constant change.
    if (Array.isArray(node)) return node.filter(item=>!(item?.type==='ExpressionStatement'&&item.directive==='use strict')).map(clean);
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'Identifier') return {type: 'Identifier'};
    if (node.type === 'Literal') return {type: 'Literal', valueType: node.regex ? 'regexp' : node.bigint ? 'bigint' : node.value === null ? 'null' : typeof node.value};
    return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'loc', 'raw'].includes(key)).map(([key, value]) => [key, clean(value)]));
  };
  return sha256(clean(parse(source, {ecmaVersion: 'latest', sourceType: 'script'})));
}

const sparse = () => { const xs = new Array(3); xs[1] = undefined; return xs; };
const definition = (name, body, inputs, features = [], tier = 2) => ({name, source: 'function run(a,b){' + body + '}', inputs, features, tier});
export function boundaryTemplates() {
  return [
    definition('bounded-range', 'if(a<0)return 0;if(a>b)return b;return a;', [[-3,5],[0,5],[3,5],[9,5]], ['branch'], 1),
    definition('object-counter-alias', 'a.count+=b;return a;', [[{count:0},1],[{count:3},-2],[{count:-1},1],[{count:8},4]], ['mutation','alias'], 3),
    definition('property-delete-presence', 'const before=("x" in a);delete a.x;return [before,("x" in a),a];', [[{x:undefined},0],[{},0],[{x:4,y:2},0],[{x:null},0]], ['mutation','property-presence','alias'], 3),
    definition('append-shared-object', 'a.push(a[0]);return a;', [[[{x:1}],0],[[],0],[[{x:2},{x:3}],0],[[{x:0}],0]], ['array','mutation','alias'], 3),
    definition('create-self-cycle', 'a.self=a;return a;', [[{n:1},0],[{},0],[{n:-1},0],[{n:9},0]], ['mutation','cycle','alias'], 3),
    definition('sparse-slot-presence', 'return [a.length,0 in a,1 in a,2 in a];', [[sparse(),0],[[undefined],0],[[],0],[[1,undefined,3],0]], ['array','sparse','property-presence'], 2),
    definition('make-sparse-mutation', 'a.length=4;a[2]=b;delete a[0];return a;', [[[1,2],9],[[],0],[[undefined],-1],[[1,2,3,4,5],2]], ['array','sparse','mutation','alias'], 3),
    definition('negative-zero-reciprocal', 'return [a,1/a,Object.is(a,-0)];', [[-0,0],[0,0],[2,0],[-2,0]], ['exceptional-scalar'], 1),
    definition('nonfinite-arithmetic', 'return [a/b,a%b,a===a];', [[0,0],[1,0],[-1,0],[NaN,2]], ['exceptional-scalar'], 1),
    definition('bigint-quotient', 'return [a/b,a%b];', [[9n,2n],[-9n,2n],[0n,3n],[21n,5n]], ['bigint'], 2),
    definition('null-prototype-result', 'const result=Object.create(null);result.value=a;return result;', [[1,0],[null,0],[undefined,0],[{x:2},0]], ['null-prototype','object'], 3),
    definition('user-object-js-key', 'a.$js=b;return a;', [[{},'literal'],[{x:1},'undefined'],[{$js:'old'},'ref'],[{},'array']], ['object','mutation','alias'], 3),
    {...definition('throw-or-return', 'if(a<0)throw b;return a+b;', [[-1,'bad'],[1,2],[0,3],[-2,{reason:'bad'}]], ['branch','exception'], 3),throws:i=>i===0||i===3},
    definition('catch-finally-mutation', 'try{if(b<0)throw b;return b*2;}catch(e){return e-1;}finally{a.count++;}', [[{count:0},2],[{count:1},-2],[{count:2},0],[{count:3},-1]], ['exception','mutation','finally'], 3),
    {...definition('standard-error-profile', 'if(a)throw new TypeError("bad input");return b;', [[true,0],[false,2],[true,3],[false,undefined]], ['exception','standard-error'], 3),throws:i=>i===0||i===2},
    definition('short-circuit-side-effect', 'const result=a.flag&&(a.count+=b);return [result,a];', [[{flag:false,count:1},3],[{flag:true,count:1},3],[{flag:0,count:2},1],[{flag:true,count:0},-2]], ['branch','mutation'], 3),
    definition('nullish-coalescing', 'return a??b;', [[null,4],[undefined,5],[0,7],[false,9]], ['branch','nullish'], 1),
    definition('nested-object-alias', 'a.inner.value+=b;return [a.inner,a];', [[{inner:{value:1}},2],[{inner:{value:0}},0],[{inner:{value:-3}},1],[{inner:{value:5}},-2]], ['mutation','alias','nested-object'], 3),
    definition('array-reverse-in-place', 'let i=0;let j=a.length-1;while(i<j){const x=a[i];a[i]=a[j];a[j]=x;i++;j--;}return a;', [[[],0],[[1],0],[[1,2,3],0],[[4,3,2,1],0]], ['loop','array','mutation','alias'], 3),
    definition('array-splice-observation', 'const removed=a.splice(b,1);return [removed,a];', [[[],0],[[1,2,3],1],[[4],0],[[1,2,3,4],-1]], ['array','mutation','alias'], 3),
    definition('string-codepoint-vs-unit', 'return [a.length,a.charCodeAt(b),a.codePointAt(b)];', [['A😀B',1],['abc',0],['',0],['éZ',1]], ['string','unicode'], 2),
    definition('own-property-order', 'a.z=b;a["2"]=a.x;delete a.x;return Object.keys(a);', [[{x:1,y:2},3],[{},0],[{x:undefined},1],[{x:null,z:4},9]], ['object','mutation','property-order'], 3),
    definition('destructure-defaults', 'const {x=2,y=b}=a;return [x,y];', [[{},3],[{x:undefined},4],[{x:null,y:0},7],[{x:9,y:1},2]], ['object','undefined','destructure'], 2),
    definition('loop-break-continue', 'let sum=0;for(let i=0;i<a.length;i++){if(a[i]<0)continue;if(a[i]>b)break;sum+=a[i];}return sum;', [[[],4],[[1],4],[[-1,2,8,1],4],[[0,1,2,3],3]], ['loop','branch','break','continue'], 2),
    {name:'observed-branch-write',source:'async function run(a){const value=await host.readAsync("value");if(value>a){host.store("chosen",value);return value;}host.store("chosen",0);return 0;}',
      inputs:[[3],[3],[3],[3]],features:['external','branch','mutation'],tier:4,
      fixture:i=>{const n=[-1,3,4,9][i%4];return {calls:[{operation:'demo.readAsync',arguments:['value'],result:n},{operation:'demo.store',arguments:['chosen',n>3?n:0]}]};}},
    {name:'sequential-observation-dependent-call',source:'async function run(){const a=await host.readAsync("first");const b=await host.readAsync(a>0?"positive":"nonpositive");return a-b;}',
      inputs:[[],[],[],[]],features:['external','sequential','branch'],tier:5,
      fixture:i=>{const a=[-2,0,3,5][i%4],b=[4,1,2,-3][i%4];return {calls:[{operation:'demo.readAsync',arguments:['first'],result:a},{operation:'demo.readAsync',arguments:[a>0?'positive':'nonpositive'],result:b}]};}},
    {name:'rejected-read-caught',source:'async function run(a){try{return (await host.readAsync("value"))+a;}catch(e){return ["caught",e,a];}}',
      inputs:[[1],[1],[1],[1]],features:['external','exception'],tier:4,
      fixture:i=>({calls:[{operation:'demo.readAsync',arguments:['value'],result:i%2?'missing':i,status:i%2?'rejected':'fulfilled'}]})},
    {name:'two-observations-finally',source:'async function run(){let a=await host.readAsync("a");try{a+=await host.readAsync("b");return a;}finally{host.store("cleanup",a);}}',
      inputs:[[],[],[],[]],features:['external','sequential','finally','exception'],tier:5,
      throws:i=>i%2===1,
      fixture:i=>({calls:[{operation:'demo.readAsync',arguments:['a'],result:i},{operation:'demo.readAsync',arguments:['b'],result:i%2?'stop':2,status:i%2?'rejected':'fulfilled'},{operation:'demo.store',arguments:['cleanup',i%2?i:i+2]}]})},
  ];
}

function featureTags(source, extra = []) {
  return [...new Set([...extra,
    ...(/\b(?:for|while)\b/.test(source) ? ['loop'] : []), ...(/\bif\b|\?/.test(source) ? ['branch'] : []),
    ...(/\bthrow\b|\bcatch\b/.test(source) ? ['exception'] : []), ...(/host\.|Date\.now|console\./.test(source) ? ['external'] : []),
    ...(/\.length|\[[^\]]*\]/.test(source) ? ['array'] : [])])].sort();
}

function templateInputs(template) {
  if (template.inputs.length >= 4) return template.inputs;
  const [a,b] = template.inputs[0];
  const edge = [Array.isArray(a) ? [] : 0, Array.isArray(b) ? [] : (typeof b === 'number' ? Math.max(1,b) : b)];
  const novel = [Array.isArray(a) ? [2,0,-1,3] : 7, Array.isArray(b) ? [1,2,3,4] : (typeof b === 'number' ? Math.max(1,b+1) : b)];
  return [...template.inputs, edge, novel];
}

function decorate(raw, {template, index, form, sourceOrigin, seed}) {
  const family = raw.family ?? 'generated:' + template.name;
  return {...raw, id: raw.id ?? family.replaceAll(/[^a-zA-Z0-9_-]/g,'-') + '-' + form + '-' + index,
    family, args: encodeReadable(raw.args ?? []), fixture: {calls: (raw.fixture?.calls ?? []).map(call => ({...call,
      arguments: encodeReadable(call.arguments ?? []), result: encodeReadable(call.result)})),
      ...(raw.fixture?.settlementOrder ? {settlementOrder: raw.fixture.settlementOrder} : {})},
    randomSeed: seed, maxSteps: 100000, timeoutMs: 10000,
    metadata: {features: featureTags(raw.source, template.features), tier: Math.max(template.tier ?? 2, form.startsWith('observed') ? 4 : form === 'packet' ? 3 : 1),
      template: family, lineage: [...new Set([family, ...(raw.ancestorIds ?? []), 'near-clone:' + nearCloneHash(template.source)])],
      sourceOrigin, sourceForm: form, inputVariant: index, evaluationRole: 'generalization',
      branchTargets: ['boundary-inputs','ordinary-inputs', ...(template.fixture ? ['counterfactual-observations','exceptional-observations-when-declared'] : [])],
      agentTaskSuccessVerified: false, ...raw.metadata}};
}

function expandTemplate(template, seed) {
  const inputs = templateInputs(template), rows = [];
  const core = template.source.replace(/\bfunction\s+run\b/, 'function __benchmarkCore');
  if (core === template.source) throw Error('Generator template must declare run');
  for (let i=0;i<inputs.length;i++) {
    const original = template.fixture?.(i) ?? {calls:[]}, args=structuredClone(inputs[i]);
    const forms = [
      ['direct',template.source,args,original],
      ['structured',core+'\nasync function run(...args){return {answer:await __benchmarkCore(...args)};}',args,original],
      ['packet',core+'\nasync function run(packet){packet.answer=await __benchmarkCore(...packet.inputs);return packet;}',[{inputs:args}],original],
      ['observed-prefix',core+'\nasync function run(...args){const observed=await host.readAsync("offset");const answer=await __benchmarkCore(...args);return {answer,observed};}',args,
        {calls:[{operation:'demo.readAsync',arguments:['offset'],result:[0,2,-3,7][i%4]},...original.calls]}],
      ['observed-branch',core+'\nasync function run(...args){const gate=await host.readAsync("gate");const answer=await __benchmarkCore(...args);host.store("selected",gate>0?gate:0);return answer;}',args,
        {calls:[{operation:'demo.readAsync',arguments:['gate'],result:[-2,0,3,7][i%4]},...original.calls,
          ...(template.throws?.(i)?[]:[{operation:'demo.store',arguments:['selected',Math.max(0,[-2,0,3,7][i%4])]}])]}],
    ];
    for (const [form,source,actualArgs,fixture] of forms) rows.push(decorate({source,entry:'run',args:actualArgs,fixture},{template,index:i,form,sourceOrigin:'authored-generator',seed}));
  }
  return rows;
}

export function generatedCandidates({seed = 17} = {}) {
  seededRandom(seed);
  const templates = [
    ...SEMANTIC_TASK_TEMPLATES.map(item=>({name:'expression-'+item.name,source:'function run(a,b){return '+item.expression+';}',inputs:[[8,3],[5,2]],features:['arithmetic'],tier:1})),
    ...BENCHMARK_ALGORITHMS.map(item=>({name:'algorithm-'+item.name,source:'function run(a,b){'+item.body+'}',inputs:item.inputs,features:['algorithm'],tier:2})),
    ...boundaryTemplates(),
  ];
  return templates.flatMap(template=>expandTemplate(template,seed));
}

function portableCandidate(raw, index, seed) {
  let args,preflightFailure=raw.preflightFailure;
  try{args=encodeReadable([...(raw.args??[])]);}catch(error){args=[];preflightFailure={status:'fixture_unsupported',reason:String(error.message)};}
  const metadata = {features: featureTags(raw.source ?? '', [raw.provenance?'real-source':'repository-fixture']), tier: 3, template: raw.family,
    lineage: [raw.family,...(raw.ancestorIds??[])], sourceOrigin: raw.provenance?.sourceStream ?? 'repository-fixture',
    inputVariant: raw.provenance?.inputIndex ?? index, evaluationRole:'generalization', agentTaskSuccessVerified:false,
    provenance: raw.provenance ? {upstream:raw.provenance.upstream,sourceURL:raw.provenance.sourceURL,
      license:raw.provenance.license,noticePath:raw.provenance.noticePath,transform:raw.provenance.transform,
      originalSourceSha256:raw.provenance.originalSourceSha256,transformedSourceSha256:raw.provenance.transformedSourceSha256,
      inputOrigin:raw.provenance.inputOrigin,sourceStream:raw.provenance.sourceStream} : null};
  try { metadata.lineage.push('near-clone:'+nearCloneHash(raw.source)); } catch {}
  return {id:raw.id,family:raw.family,source:raw.source,entry:raw.entry??'run',args,
    fixture:raw.fixture??{calls:[]},randomSeed:raw.seeds?.guestRng??seed,
    maxSteps:raw.maxSteps??100000,timeoutMs:raw.timeoutMs??10000,
    ...(preflightFailure?{preflightFailure}:{}), metadata};
}

export function repositoryCandidates({root=process.cwd(),seed=17,perFamily=4,streams=['utilities','exercism','production']}={}) {
  return trustedRealSourceCases({root,streams,perFamily,mutationsPerFamily:0}).map((row,i)=>portableCandidate(row,i,seed));
}

export function censusCandidates(options={}) {
  const seed=options.seed??17;
  const existing=[...EFFECTFUL_ENGINEERING_FIXTURES,
    ...semanticRecipeFamilies().flatMap(f=>[f.pure,f.callbacks,...f.repeated.cases]),
    ...benchmarkFamiliesV1().flatMap(f=>[f.pure,f.callbacks,...f.repeated.cases])];
  return [...repositoryCandidates({...options,perFamily:options.perFamily??2}),
    ...existing.map((row,i)=>portableCandidate({...row,id:'existing-'+row.id},i,seed))];
}

export function assignFrozenSplits(rows,{seed=17,validationFraction=0.2,testFraction=0.3}={}) {
  if (!(validationFraction>0&&testFraction>0&&validationFraction+testFraction<1)) throw TypeError('Invalid benchmark split fractions');
  const parent=new Map(),find=x=>{if(!parent.has(x))parent.set(x,x);if(parent.get(x)!==x)parent.set(x,find(parent.get(x)));return parent.get(x);};
  const union=(a,b)=>{a=find(a);b=find(b);if(a!==b)parent.set(a<b?b:a,a<b?a:b);};
  for(const row of rows){const ids=[row.family,...(row.metadata.lineage??[]),'template:'+row.metadata.template];
    try{ids.push('exact-source:'+normalizedSourceHash(row.source));}catch{}
    ids.forEach(id=>union(ids[0],id));}
  const groups=new Map();for(const row of rows){const component=find(row.family);if(!groups.has(component))groups.set(component,[]);groups.get(component).push(row);}
  const ordered=[...groups.keys()].sort((a,b)=>sha256(seed+':'+a).localeCompare(sha256(seed+':'+b)));
  const nt=Math.max(1,Math.round(ordered.length*testFraction)),nv=Math.max(1,Math.round(ordered.length*validationFraction));
  if(nt+nv>=ordered.length)throw Error('At least three independent family components required');
  const splits=new Map(ordered.map((component,i)=>[component,i<nt?'test':i<nt+nv?'validation':'train']));
  return rows.map(row=>({...row,split:splits.get(find(row.family)),metadata:{...row.metadata,
    component:find(row.family),lineage:[...new Set([...row.metadata.lineage,'component:'+find(row.family)])]}}));
}

export function datasetCounts(rows) {
  const count=list=>({cases:list.length,families:new Set(list.map(r=>r.family)).size,
    independentComponents:new Set(list.map(r=>r.metadata.component??r.family)).size,
    sourcePrograms:new Set(list.map(r=>sha256(r.source))).size});
  return {total:count(rows),bySplit:Object.fromEntries(['train','validation','test'].map(split=>[split,count(rows.filter(r=>r.split===split))])),
    byFeature:Object.fromEntries([...new Set(rows.flatMap(r=>r.metadata.features??[]))].sort().map(feature=>[feature,rows.filter(r=>r.metadata.features?.includes(feature)).length]))};
}

export function executionInputSignature(row) {
  return sha256({source:row.source,entry:row.entry??'run',language:row.language??'js',args:row.args??[],
    randomSeed:row.randomSeed??17,
    nativeBindings:(row.nativeBindings??[]).map(binding=>({name:binding.name,kind:binding.kind??'synchronous'})),
    fixture:{calls:(row.fixture?.calls??[]).map(call=>({operation:call.operation,arguments:call.arguments??[],
      status:call.status??'fulfilled',result:Object.hasOwn(call,'result')?call.result:{$js:'undefined'}})),settlementOrder:row.fixture?.settlementOrder??null}});
}

export function splitDiagnosticInputs(rows) {
  // Keep a fourth variant only for a familiar-input diagnostic when earlier
  // variants of that same exact source exist in training. Never move a test row.
  const seen=new Set(rows.filter(r=>r.split==='train'&&r.metadata.inputVariant!==3).map(r=>sha256(r.source)));
  const candidates=[],main=[];
  for(const row of rows){
    if(row.split==='train'&&row.metadata.inputVariant===3&&seen.has(sha256(row.source))){
      candidates.push(row);
    }else main.push(row);
  }
  const trainingKeys=new Set(main.filter(row=>row.split==='train').map(executionInputSignature)),diagnosticKeys=new Set();
  const familiar=[],duplicateDiagnosticInputs=[];
  for(const row of candidates){
    const signature=executionInputSignature(row),reason=trainingKeys.has(signature)?'duplicates-training-execution':
      diagnosticKeys.has(signature)?'duplicates-familiar-diagnostic':null;
    if(reason){duplicateDiagnosticInputs.push({id:row.id,family:row.family,signature,reason});continue;}
    diagnosticKeys.add(signature);
    familiar.push({...row,id:row.id+'-familiar',split:'test',metadata:{...row.metadata,evaluationRole:'familiar_inputs',diagnosticOnly:true,
      inputNovelty:'execution-input-signature-absent-from-training',executionInputSignature:signature}});
  }
  return {main,familiar,duplicateDiagnosticInputs};
}

export function challengeCandidates(rows,{seed=17,limit=120}={}) {
  const selected=rows.filter(r=>r.split==='test'&&r.metadata.sourceOrigin==='authored-generator'&&
    r.metadata.sourceForm==='direct'&&r.metadata.inputVariant===1&&r.metadata.features.includes('loop'))
    .sort((a,b)=>sha256(seed+':'+a.id).localeCompare(sha256(seed+':'+b.id))).slice(0,limit);
  return selected.map(row=>{
    // Longer inputs retain source ancestry. Additional repeated calls compose
    // the existing algorithm without inventing a new independent family.
    const core=row.source.replace(/\bfunction\s+run\b/,'function __challengeCore');
    const source=core+'\nfunction run(a,b){const first=__challengeCore(a,b);const second=__challengeCore(a,b);return [first,second];}';
    const args=structuredClone(row.args);
    if(Array.isArray(args[0])){const a=args[0];args[0]=[...a,...a,...a,...a];if(Array.isArray(args[1]))args[1]=[...args[1],...args[1],...args[1],...args[1]];}
    return {...row,id:row.id+'-long-composition',source,args,metadata:{...row.metadata,evaluationRole:'challenge',diagnosticOnly:true,
      sourceForm:'longer-repeated-composition',features:[...new Set([...row.metadata.features,'longer-execution','composition'])],tier:5}};
  });
}

export function readCandidateJsonl(path) {
  return readFileSync(resolve(path),'utf8').split(/\r?\n/).filter(Boolean).map((line,i)=>{try{return JSON.parse(line);}catch{throw Error('Invalid JSONL at '+path+':'+(i+1));}});
}
