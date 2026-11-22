// Frozen Test262 acquisition and variant accounting. A catalog is not a
// conformance result: missing harnesses, classifications and modules stay visible.
import {createHash} from 'node:crypto';
import {gitBlobSha} from '../test262-baseline.js';

export const CONFORMANCE_STAGES=Object.freeze([
  'parseStatic','ownedExecution','independentReference','sourceCorrespondence',
  'publicReplay','nativeReplay','checkpointRestore','datasetExport',
  'ordinaryTraining','serving','learnedUsefulness'
]);
export const CONFORMANCE_DISPOSITIONS=Object.freeze([
  'passed','failed','unsupported','resource_limited','environment_unavailable',
  'not_selected','not_run','blocked_by_prior_stage','infrastructure_error'
]);
const prerequisites={
  parseStatic:[],ownedExecution:['parseStatic'],independentReference:[],
  sourceCorrespondence:['ownedExecution','independentReference'],
  publicReplay:['sourceCorrespondence'],nativeReplay:['publicReplay'],
  checkpointRestore:['nativeReplay'],datasetExport:['checkpointRestore'],
  ordinaryTraining:['datasetExport'],serving:['ordinaryTraining'],learnedUsefulness:['serving']
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hex40=/^[0-9a-f]{40}$/;
const hex64=/^[0-9a-f]{64}$/;
const own=(object,key)=>Object.hasOwn(object,key);
const exactFields=(value,keys)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>own(value,key));
const canonical=value=>{
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)
    return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  throw new TypeError('Conformance identities require finite JSON data');
};
export const conformanceDigest=value=>sha(canonical(value));
const freeze=value=>{
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}
  return value;
};
export const safeTest262Path=path=>typeof path==='string'&&/^(?:test|harness)\//.test(path)&&
  !/[\\\x00-\x1f\x7f]/.test(path)&&!path.split('/').some(part=>part==='.'||part==='..'||part==='');
const safeInclude=name=>typeof name==='string'&&/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.js$/.test(name)&&
  !name.split('/').some(part=>part==='..'||part==='.'||part==='');
const membershipValues=new Set(['edition','extension','outside_profile','unclassified']);
const membershipReviewSchema='test262-edition-membership-review/1';
const decode=source=>{
  if(typeof source==='string')return source;
  if(source instanceof Uint8Array)return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source);
  throw new TypeError('Test262 source bytes are required');
};
const atom=text=>{
  const value=text.trim().replace(/\s+#.*$/,'').trim();
  if(!/^(?:[A-Za-z0-9_$./+@-]+|'[A-Za-z0-9_$./+@-]+'|"[A-Za-z0-9_$./+@-]+")$/.test(value))
    throw new TypeError('Unsupported Test262 metadata scalar: '+text);
  return value.replace(/^['"]|['"]$/g,'');
};

/** Interpret routing metadata without executing or rewriting original source.
 * Descriptive YAML is retained by source digest; executable fields are strict. */
export function parseTest262Header(source){
  if(typeof source!=='string')throw new TypeError('Test262 source must be text');
  // Some upstream lexical tests deliberately use CR-only line endings. Decode
  // metadata on a copy; original source bytes remain the execution authority.
  const metadataSource=source.replace(/\r\n?/g,'\n');
  const matches=[...metadataSource.matchAll(/\/\*---[ \t]*\n([\s\S]*?)\n---\*\//g)];
  if(matches.length!==1)throw new TypeError('Test262 requires exactly one metadata header');
  const fields=new Map();let current=null;
  const lines=matches[0][1].split('\n');
  const indent=Math.min(...lines.filter(line=>line.trim()&&!/^\s*#/.test(line)).map(line=>/^ */.exec(line)[0].length));
  for(const original of lines){
    const line=original.slice(Number.isFinite(indent)?indent:0);
    if(!line.trim()||/^\s*#/.test(line))continue;
    const top=/^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if(top){
      if(fields.has(top[1]))throw new TypeError('Duplicate Test262 metadata key: '+top[1]);
      current={head:top[2],tail:[]};fields.set(top[1],current);
    }else if(/^\s/.test(line)&&current)current.tail.push(line);
    else throw new TypeError('Malformed Test262 metadata line');
  }
  const list=name=>{
    if(!fields.has(name))return [];
    const {head,tail}=fields.get(name);let values;
    if(head.trim()){
      const match=/^\[([^\]\r\n]*)\][ \t]*(?:#.*)?$/.exec(head);
      if(!match||tail.some(line=>line.trim()))throw new TypeError('Malformed Test262 '+name+' list');
      values=match[1].trim()?match[1].split(',').map(atom):[];
    }else values=tail.map(line=>{
      const match=/^\s+-[ \t]+(.+)$/.exec(line);
      if(!match)throw new TypeError('Malformed Test262 '+name+' list');
      return atom(match[1]);
    });
    if(new Set(values).size!==values.length)throw new TypeError('Duplicate Test262 '+name+' item');
    return values;
  };
  const flags=list('flags'),includes=list('includes'),features=list('features');
  const validFlags=['onlyStrict','noStrict','module','raw','async','generated','non-deterministic',
    'CanBlockIsFalse','CanBlockIsTrue'];
  if(flags.some(flag=>!validFlags.includes(flag))||
    flags.includes('onlyStrict')&&flags.includes('noStrict')||
    flags.includes('module')&&(flags.includes('noStrict')||flags.includes('onlyStrict'))||
    flags.includes('raw')&&flags.some(flag=>!['raw','generated','module'].includes(flag))||
    flags.includes('CanBlockIsFalse')&&flags.includes('CanBlockIsTrue'))
    throw new TypeError('Conflicting or unknown Test262 flags');
  if(includes.some(name=>!safeInclude(name))||flags.includes('raw')&&includes.length)
    throw new TypeError('Unsafe or incompatible Test262 harness include');
  let negative=null;
  if(fields.has('negative')){
    const {head,tail}=fields.get('negative'),parts={};
    if(head.trim())throw new TypeError('Malformed Test262 negative metadata');
    for(const line of tail){
      const match=/^\s+(phase|type):[ \t]*(.+)$/.exec(line);
      if(!match||own(parts,match[1]))throw new TypeError('Malformed Test262 negative metadata');
      parts[match[1]]=atom(match[2]);
    }
    if(!['parse','early','resolution','runtime'].includes(parts.phase)||
      !/^[A-Za-z_$][\w$]*$/.test(parts.type??''))throw new TypeError('Invalid Test262 negative phase or type');
    if(parts.phase==='resolution'&&!flags.includes('module'))throw new TypeError('Resolution negative requires module goal');
    negative={phase:parts.phase,type:parts.type};
  }
  return {flags,includes,features,negative,...(fields.has('locale')?{locale:list('locale')}:{})};
}

export function test262VariantModes(metadata){
  const flags=metadata.flags;
  return flags.includes('module')?['module']:flags.includes('raw')?['raw']:
    flags.includes('onlyStrict')?['strict']:flags.includes('noStrict')?['sloppy']:['sloppy','strict'];
}

function validateMembershipClassification(classification,{suiteRevision,profile,sourceInputs,path,sourceDigest}={}){
  if(!classification||!membershipValues.has(classification.membership)||
    typeof classification.requiredForThisRelease!=='boolean'||
    classification.membership==='outside_profile'&&
      (typeof classification.reason!=='string'||!classification.reason.trim()||classification.requiredForThisRelease))
    throw new TypeError('Invalid Test262 edition/release classification');
  const classificationKeys=classification.membership==='unclassified'?['membership','requiredForThisRelease']:
    classification.membership==='outside_profile'?['membership','requiredForThisRelease','reason','evidence']:
      ['membership','requiredForThisRelease','evidence'];
  if(!exactFields(classification,classificationKeys))throw new TypeError('Invalid Test262 classification fields');
  if(classification.membership==='unclassified'){
    if(Object.hasOwn(classification,'evidence'))throw new TypeError('Unclassified Test262 membership cannot carry a decision');
    return true;
  }
  const evidence=classification.evidence;
  const evidenceProblem=!exactFields(evidence,['schema','reviewer','method','rationale','suiteRevision','sourceDigest','profileDigest',
      'hostProfileDigest','editionSpecification','sourceInputs','normativeObligations'])?'evidence fields':
    evidence.schema!==membershipReviewSchema?'evidence schema':!exactFields(evidence.reviewer,['kind','identity'])?'reviewer fields':
    !['human','assistant','tool-assisted'].includes(evidence.reviewer?.kind)?'reviewer kind':
    typeof evidence.reviewer?.identity!=='string'||!evidence.reviewer.identity.trim()?'reviewer identity':
    typeof evidence.method!=='string'||!evidence.method.trim()?'review method':
    typeof evidence.rationale!=='string'||!evidence.rationale.trim()?'review rationale':
    evidence.suiteRevision!==suiteRevision?'suite revision':evidence.sourceDigest!==sourceDigest?'test source digest':
    evidence.profileDigest!==conformanceDigest(profile)?'profile digest':
    evidence.hostProfileDigest!==conformanceDigest(profile.hostProfile)?'host profile digest':
    !profile.specification||!exactFields(evidence.editionSpecification,['uri','sha256'])?'edition specification fields':
    evidence.editionSpecification?.uri!==profile.specification.uri||
      evidence.editionSpecification?.sha256!==profile.specification.sha256?'edition specification identity':
    !Array.isArray(evidence.sourceInputs)?'source input list':
    conformanceDigest(evidence.sourceInputs)!==conformanceDigest(sourceInputs)?'source input closure':
    evidence.sourceInputs.some(row=>!exactFields(row,['path','sha256','kind'])||
      !['test','harness','module-dependency'].includes(row.kind)||!hex64.test(row.sha256??''))?'source input fields':
    !Array.isArray(evidence.normativeObligations)||!evidence.normativeObligations.length?'normative obligations':null;
  if(evidenceProblem)throw new TypeError('Non-unclassified Test262 membership requires exact evidence: '+evidenceProblem);
  let editionObligation=false,externalObligation=false;
  for(const obligation of evidence.normativeObligations){
    if(!exactFields(obligation,['basis','uri','sha256','clauseIds'])||
      !['edition','addition','profile'].includes(obligation.basis)||
      typeof obligation.uri!=='string'||!obligation.uri||!hex64.test(obligation.sha256??'')||
      !Array.isArray(obligation.clauseIds)||!obligation.clauseIds.length||
      obligation.clauseIds.some(id=>typeof id!=='string'||!id.trim()))
      throw new TypeError('Membership review must cite exact normative obligations');
    const isEdition=obligation.uri===profile.specification.uri&&obligation.sha256===profile.specification.sha256;
    if(obligation.basis==='edition'&&!isEdition||obligation.basis!=='edition'&&isEdition)
      throw new TypeError('Membership obligation basis differs from its pinned specification');
    if(isEdition)editionObligation=true;else externalObligation=true;
  }
  if(classification.membership==='edition'&&!editionObligation||
    classification.membership==='extension'&&!externalObligation)
    throw new TypeError('Membership review lacks a normative obligation for its declared membership');
  return true;
}

/** Snapshot pins, not directory search or execution success, define the files.
 * All source bytes must be present and verified before the denominator freezes.
 * Module dependency maps are explicit acquisition inputs, never guessed by regex. */
export function buildTest262Catalog({snapshot,sources,profile,moduleDependencies={},classifications={}}={}){
  if(snapshot?.repository!=='tc39/test262'||!hex40.test(snapshot.revision??'')||
    !snapshot.files||typeof snapshot.files!=='object'||Array.isArray(snapshot.files)||
    !sources||typeof sources!=='object')throw new TypeError('Pinned Test262 snapshot and source bytes required');
  if(!profile||typeof profile.name!=='string'||!profile.name||typeof profile.edition!=='string'||
    !profile.resourcePolicy||!profile.hostProfile||!profile.parser)
    throw new TypeError('Conformance profile needs edition, parser, host and resource policy');
  if(!['maxSteps','maxSourceBytes'].every(key=>Number.isSafeInteger(profile.resourcePolicy[key])&&profile.resourcePolicy[key]>0))
    throw new TypeError('Conformance resource policy needs positive maxSteps and maxSourceBytes');
  if(profile.specification!==null&&(!profile.specification||!hex64.test(profile.specification.sha256??'')||
    typeof profile.specification.uri!=='string'))throw new TypeError('Use an exact specification digest or explicit null');
  const boundProfile=JSON.parse(canonical(profile));
  const files=[];const texts=new Map();
  for(const path of Object.keys(snapshot.files).sort()){
    if(!safeTest262Path(path)||!hex40.test(snapshot.files[path]))throw new TypeError('Invalid pinned Test262 path or blob');
    if(!own(sources,path))throw new TypeError('Missing pinned source bytes: '+path);
    const bytes=typeof sources[path]==='string'?Buffer.from(sources[path]):sources[path];
    if(!(bytes instanceof Uint8Array))throw new TypeError('Test262 source bytes required');
    if(gitBlobSha(Buffer.from(bytes))!==snapshot.files[path])throw new TypeError('Test262 blob mismatch: '+path);
    const kind=!path.endsWith('.js')?'resource':path.startsWith('harness/')?'harness':path.split('/').at(-1).includes('_FIXTURE')?'fixture':'test';
    let source=null,sourceError=null;
    if(kind!=='resource')try{source=decode(bytes);}catch(error){sourceError=error.message;}
    texts.set(path,source);
    files.push({path,gitBlobSha:snapshot.files[path],sha256:sha(bytes),bytes:bytes.length,kind,
      ...(sourceError?{sourceError}:{})});
  }
  if(!files.some(file=>file.kind==='test'))throw new TypeError('Test262 catalog has no test files');
  for(const map of [moduleDependencies,classifications])
    if(Object.keys(map).some(path=>!texts.has(path)))throw new TypeError('Catalog annotation names an unpinned file');
  const byPath=new Map(files.map(file=>[file.path,file]));
  const closure=path=>{
    const seen=new Set(),missing=new Set(),pending=[path];
    while(pending.length){
      const current=pending.pop();if(seen.has(current))continue;seen.add(current);
      if(!own(moduleDependencies,current)){missing.add(current);continue;}
      const declared=moduleDependencies[current],paths=Array.isArray(declared)?declared:declared.paths;
      const unresolved=Array.isArray(declared)?[]:declared.unresolved;
      if(!Array.isArray(paths)||new Set(paths).size!==paths.length||!Array.isArray(unresolved)||
        unresolved.some(item=>typeof item!=='string'))
        throw new TypeError('Module dependency list must be unique');
      for(const reason of unresolved)missing.add(current+': '+reason);
      for(const dependency of paths){
        if(!safeTest262Path(dependency)||!dependency.startsWith('test/')||!byPath.has(dependency))
          throw new TypeError('Unpinned module dependency: '+dependency);
        pending.push(dependency);
      }
    }
    return {status:missing.size?'unresolved':'complete',unresolved:[...missing].sort(),
      files:[...seen].sort().map(name=>({path:name,sha256:byPath.get(name).sha256}))};
  };
  const variants=[];
  for(const file of files.filter(file=>file.kind==='test')){
    let metadata=null,metadataError=null;
    try{
      if(file.sourceError)throw new TypeError(file.sourceError);
      metadata=parseTest262Header(texts.get(file.path));
    }catch(error){metadataError=error.message;}
    const modes=metadata?test262VariantModes(metadata):['unclassified'];
    for(const mode of modes){
      const harness=metadata&&!metadata.flags.includes('raw')?[...new Set(['assert.js','sta.js',
        ...(metadata.flags.includes('async')?['doneprintHandle.js']:[]),...metadata.includes])]:[];
      const moduleFiles=mode==='module'?closure(file.path).files.filter(row=>row.path!==file.path):[],
        sourceInputs=[{path:file.path,sha256:file.sha256,kind:'test'},
          ...harness.map(name=>({path:'harness/'+name,sha256:byPath.get('harness/'+name)?.sha256??null,kind:'harness'})),
          ...moduleFiles.map(row=>({path:row.path,sha256:row.sha256,kind:'module-dependency'}))]
          .sort((a,b)=>a.path.localeCompare(b.path)||a.kind.localeCompare(b.kind));
      const classification=classifications[file.path]??{membership:'unclassified',requiredForThisRelease:false};
      validateMembershipClassification(classification,{suiteRevision:snapshot.revision,profile:boundProfile,
        sourceInputs,path:file.path,sourceDigest:file.sha256});
      const row={path:file.path,sourceDigest:file.sha256,gitBlobSha:file.gitBlobSha,mode,
        metadata,metadataError,classification:JSON.parse(canonical(classification)),
        expectedOutcome:metadata?.negative?{kind:'error',...metadata.negative}:{kind:'normal'},
        harness:harness.map(name=>({path:'harness/'+name,sha256:byPath.get('harness/'+name)?.sha256??null})),
        dependencies:mode==='module'?closure(file.path):{status:'not_required',unresolved:[],files:[]},
        requiredHostCapabilities:metadata?[...(metadata.flags.includes('async')?['async-completion']:[]),
          ...(mode==='module'?['module-linker']:[]),
          ...(metadata.features.some(feature=>/^(?:Atomics|SharedArrayBuffer)/.test(feature))?['agent-cluster']:[])]:[]};
      const id=conformanceDigest({suiteRevision:snapshot.revision,profile:boundProfile,...row});
      variants.push({id,...row});
    }
  }
  const catalog={schema:'test262-frozen-catalog/1',repository:snapshot.repository,suiteRevision:snapshot.revision,
    acquisition:snapshot.acquisition??{kind:'retained-snapshot',fullUpstreamTree:false},
    profile:boundProfile,files,variants,
    summary:{discoveredFiles:files.length,testFiles:files.filter(file=>file.kind==='test').length,
      fixtureFiles:files.filter(file=>file.kind==='fixture').length,harnessFiles:files.filter(file=>file.kind==='harness').length,
      resourceFiles:files.filter(file=>file.kind==='resource').length,
      knownVariants:variants.filter(row=>row.mode!=='unclassified').length,
      unresolvedMetadataFiles:variants.filter(row=>row.mode==='unclassified').length,
      variantPopulationComplete:variants.every(row=>row.mode!=='unclassified'),
      missingHarnessFiles:[...new Set(variants.flatMap(row=>row.harness.filter(file=>file.sha256===null).map(file=>file.path)))].sort(),
      specificationPinned:boundProfile.specification!==null},
    claims:{fullSuiteAcquired:snapshot.acquisition?.fullUpstreamTree===true,fullEditionInventory:false,ownedConformance:false}};
  return freeze({...catalog,digest:conformanceDigest(catalog)});
}

export function validateTest262Catalog(catalog){
  if(catalog?.schema!=='test262-frozen-catalog/1'||!hex64.test(catalog.digest??''))
    throw new TypeError('Unknown Test262 catalog');
  const {digest,...identity}=catalog;
  if(conformanceDigest(identity)!==digest)throw new TypeError('Test262 catalog digest mismatch');
  if(!Array.isArray(catalog.variants)||new Set(catalog.variants.map(row=>row.id)).size!==catalog.variants.length)
    throw new TypeError('Duplicate or missing Test262 variants');
  const files=new Map((catalog.files??[]).map(file=>[file.path,file]));
  const classifications=new Map();
  for(const row of catalog.variants){
    const sourceInputs=[{path:row.path,sha256:row.sourceDigest,kind:'test'},
      ...(row.harness??[]).map(file=>({path:file.path,sha256:file.sha256,kind:'harness'})),
      ...(row.dependencies?.files??[]).filter(file=>file.path!==row.path)
        .map(file=>({path:file.path,sha256:file.sha256,kind:'module-dependency'}))]
      .sort((a,b)=>a.path.localeCompare(b.path)||a.kind.localeCompare(b.kind));
    validateMembershipClassification(row.classification,{suiteRevision:catalog.suiteRevision,profile:catalog.profile,
      sourceInputs,path:row.path,sourceDigest:row.sourceDigest});
    const sourceFile=files.get(row.path);
    if(!sourceFile||sourceFile.kind!=='test'||sourceFile.sha256!==row.sourceDigest||
      row.classification.membership!=='unclassified'&&row.classification.evidence.sourceInputs.some(input=>{
        const file=files.get(input.path);return !file||file.sha256!==input.sha256||
          input.kind==='harness'&&file.kind!=='harness'||input.kind==='module-dependency'&&file.kind!=='test';
      }))throw new TypeError('Membership review source bytes do not match the frozen catalog: '+row.path);
    if(classifications.has(row.path)&&conformanceDigest(classifications.get(row.path))!==
      conformanceDigest(row.classification))throw new TypeError('Test262 variants disagree on file membership review: '+row.path);
    classifications.set(row.path,row.classification);
  }
  return true;
}

/** Derive a new execution profile over the exact same frozen file population.
 * The original inventory remains immutable; every variant receives a new
 * profile-bound identity and no campaign stages are copied. */
export function bindTest262CatalogProfile(catalog,profile){
  validateTest262Catalog(catalog);
  if(!profile||typeof profile.name!=='string'||!profile.name||typeof profile.edition!=='string'||
    !profile.parser||!profile.hostProfile||!profile.resourcePolicy||
    !['maxSteps','maxSourceBytes'].every(key=>Number.isSafeInteger(profile.resourcePolicy[key])&&profile.resourcePolicy[key]>0)||
    profile.specification!==null&&(!profile.specification||!hex64.test(profile.specification.sha256??'')||typeof profile.specification.uri!=='string'))
    throw new TypeError('Invalid derived Test262 execution profile');
  const boundProfile=JSON.parse(canonical(profile));
  const variants=catalog.variants.map(variant=>{
    const {id,...row}=variant;
    if(conformanceDigest({suiteRevision:catalog.suiteRevision,profile:catalog.profile,...row})!==id)
      throw new TypeError('Frozen Test262 variant profile identity mismatch');
    return {id:conformanceDigest({suiteRevision:catalog.suiteRevision,profile:boundProfile,...row}),...row};
  });
  const {digest,...population}=catalog;
  const derived={...population,profile:boundProfile,variants,
    summary:{...catalog.summary,specificationPinned:boundProfile.specification!==null}};
  return freeze({...derived,digest:conformanceDigest(derived)});
}

export function createTest262Campaign({catalog,selectedIds=null,implementation}={}){
  validateTest262Catalog(catalog);
  if(!implementation||!hex40.test(implementation.producerRevision??'')||
    !hex64.test(implementation.codeDigest??'')||!hex64.test(implementation.runnerDigest??''))
    throw new TypeError('Campaign requires exact producer revision, code and runner digests');
  const allIds=catalog.variants.map(row=>row.id),ids=selectedIds??allIds,available=new Set(allIds);
  if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!available.has(id)))
    throw new TypeError('Campaign selection must contain unique catalog IDs');
  const selected=new Set(ids);
  const identity={catalogDigest:catalog.digest,implementation:JSON.parse(canonical(implementation)),
    selectedIds:allIds.filter(id=>selected.has(id))};
  return {schema:'test262-campaign/1',...identity,identityDigest:conformanceDigest(identity),
    rows:catalog.variants.map(variant=>({id:variant.id,path:variant.path,mode:variant.mode,selected:selected.has(variant.id),
      stages:Object.fromEntries(CONFORMANCE_STAGES.map(stage=>[stage,{status:selected.has(variant.id)?'not_run':'not_selected'}])),
      attempts:[]}))};
}

/** Reject incompatible resume before consuming an old row or writing evidence. */
export function validateTest262Campaign(campaign,{catalog,implementation}={}){
  const expected=createTest262Campaign({catalog,selectedIds:campaign?.selectedIds,implementation});
  if(campaign?.schema!==expected.schema||campaign.identityDigest!==expected.identityDigest||
    conformanceDigest({catalogDigest:campaign.catalogDigest,implementation:campaign.implementation,
      selectedIds:campaign.selectedIds})!==expected.identityDigest||
    !Array.isArray(campaign.rows)||campaign.rows.length!==expected.rows.length)
    throw new TypeError('Incompatible Test262 campaign resume identity');
  for(let i=0;i<expected.rows.length;i++){
    const row=campaign.rows[i],wanted=expected.rows[i];
    if(row.id!==wanted.id||row.selected!==wanted.selected||row.path!==wanted.path||row.mode!==wanted.mode||
      !row.stages||Object.keys(row.stages).length!==CONFORMANCE_STAGES.length||!Array.isArray(row.attempts))
      throw new TypeError('Test262 campaign population changed');
    validateRecordedRow(row);
  }
  return true;
}

/** Append an attempt, retaining prior failures. Evidence must already exist;
 * ledger integrity alone never certifies its semantic claim. */
export function recordTest262Stage(campaign,{caseId,stage,status,reason=null,evidence}={}){
  return recordTest262Stages(campaign,[{caseId,stage,status,reason,evidence}]);
}

/** One copy for a bounded batch, so full-population campaigns do not clone
 * 102,994 rows once for every stage of every selected variant. */
export function recordTest262Stages(campaign,results){
  if(!Array.isArray(results))throw new TypeError('Test262 stage batch must be an array');
  const next=structuredClone(campaign),rows=new Map(next.rows.map(row=>[row.id,row])),checked=new Set();
  for(const {caseId,stage,status,reason=null,evidence} of results){
    if(!CONFORMANCE_STAGES.includes(stage)||!CONFORMANCE_DISPOSITIONS.includes(status)||
      ['not_selected','not_run','blocked_by_prior_stage'].includes(status)||evidence===undefined)
      throw new TypeError('Invalid executed Test262 stage result');
    const row=rows.get(caseId);
    if(!row?.selected)throw new TypeError('Cannot execute an unselected Test262 variant');
    if(!checked.has(caseId)){validateRecordedRow(row);checked.add(caseId);}
    const attempt={sequence:row.attempts.length+1,stage,status,reason,evidence:JSON.parse(canonical(evidence)),
      evidenceDigest:conformanceDigest(evidence)};
    applyAttempt(row,attempt);
  }
  return next;
}

function validateRecordedRow(row){
  if(!Array.isArray(row.attempts))throw new TypeError('Missing Test262 attempt history');
  const replay={selected:row.selected,attempts:[],stages:Object.fromEntries(CONFORMANCE_STAGES.map(stage=>
    [stage,{status:row.selected?'not_run':'not_selected'}]))};
  for(const attempt of row.attempts){
    if(!hex64.test(attempt.evidenceDigest??'')||conformanceDigest(attempt.evidence)!==attempt.evidenceDigest)
      throw new TypeError('Test262 attempt evidence digest mismatch');
    applyAttempt(replay,attempt);
  }
  if(canonical(row.stages)!==canonical(replay.stages))
    throw new TypeError('Test262 stage disposition differs from retained attempt history');
}

function applyAttempt(row,attempt){
  const {stage,status,reason}=attempt;
  if(!row.selected||attempt.sequence!==row.attempts.length+1||
    !CONFORMANCE_STAGES.includes(stage)||!CONFORMANCE_DISPOSITIONS.includes(status)||
    ['not_selected','not_run','blocked_by_prior_stage'].includes(status)||
    reason!==null&&typeof reason!=='string')throw new TypeError('Invalid Test262 attempt sequence or result');
  const blocked=prerequisites[stage].filter(prior=>row.stages[prior].status!=='passed');
  if(blocked.length)throw new TypeError('Test262 stage is blocked by '+blocked.join(', '));
  row.attempts.push(attempt);
  row.stages[stage]={status,reason,attempt:attempt.sequence,evidenceDigest:attempt.evidenceDigest};
  // A new attempt invalidates downstream results; retained older attempts are
  // historical evidence, never implicit qualification of this new transition.
  const affected=new Set([stage]);
  for(const downstream of CONFORMANCE_STAGES){
    if(downstream===stage||!prerequisites[downstream].some(prior=>affected.has(prior)))continue;
    affected.add(downstream);
    const missing=prerequisites[downstream].filter(prior=>row.stages[prior].status!=='passed');
    row.stages[downstream]=missing.length?{status:'blocked_by_prior_stage',blockedBy:missing}:{status:'not_run'};
  }
}

export function summarizeTest262Campaign(campaign){
  const counts=Object.fromEntries(CONFORMANCE_STAGES.map(stage=>[stage,
    Object.fromEntries(CONFORMANCE_DISPOSITIONS.map(status=>[status,0]))]));
  for(const row of campaign.rows)for(const stage of CONFORMANCE_STAGES){
    const status=row.stages[stage]?.status;
    if(!CONFORMANCE_DISPOSITIONS.includes(status))throw new TypeError('Unknown Test262 disposition');
    counts[stage][status]++;
  }
  return {catalogVariants:campaign.rows.length,selected:campaign.rows.filter(row=>row.selected).length,
    attempts:campaign.rows.reduce((sum,row)=>sum+row.attempts.length,0),stages:counts};
}
