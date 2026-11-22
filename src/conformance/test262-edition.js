// Reference reconciliation is evidence for scope review, never an edition or
// execution pass inferred from an anchor, feature tag, path, or native result.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {conformanceDigest,validateTest262Catalog,parseTest262Header,test262VariantModes} from './test262-catalog.js';
import {verifyEcma262SpecificationBytes} from './test262-specification.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const extractor=fileURLToPath(new URL('./ecma262-html-inventory.py',import.meta.url));
const text=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);

/** Parse real tags, not JavaScript text or examples that merely contain IDs. */
export function extractEcma262HtmlInventory(bytes,{python='python3'}={}){
  const result=JSON.parse(execFileSync(python,[extractor],{input:bytes,maxBuffer:16*1024*1024}));
  const body={schema:'ecma262-html-inventory/1',...result,
    extractorSha256:sha(readFileSync(extractor)),htmlSha256:sha(bytes),htmlBytes:bytes.length};
  return {...body,digest:conformanceDigest(body)};
}

/** Read descriptive references separately: frozen routing metadata is unchanged. */
export function test262SpecificationReference(source){
  // Routing validation also rejects duplicate/malformed headers. It does not
  // add esid to existing metadata identities or reinterpret an old catalog.
  parseTest262Header(source);
  const header=source.replace(/\r\n?/g,'\n').match(/\/\*---[ \t]*\n([\s\S]*?)\n---\*\//)[1];
  const lines=header.split('\n'),indent=Math.min(...lines.filter(line=>line.trim()&&!/^\s*#/.test(line))
    .map(line=>/^ */.exec(line)[0].length));
  const values={};
  for(const original of lines){
    const match=/^(esid|es5id|es6id):[ \t]*(.*)$/.exec(original.slice(Number.isFinite(indent)?indent:0));
    if(!match)continue;
    const raw=match[2].trim().replace(/[ \t]+#.*$/,'').trim();
    const scalar=/^(?:([A-Za-z0-9_$.:/%#?=&+@-]+)|'([A-Za-z0-9_$.:/%#?=&+@-]+)'|"([A-Za-z0-9_$.:/%#?=&+@-]+)")$/.exec(raw);
    values[match[1]]=scalar?{status:'scalar',value:scalar[1]??scalar[2]??scalar[3]}:
      {status:'unresolved',raw};
  }
  return values;
}

function targetFor(reference,specification){
  if(!reference)return {status:'missing_metadata',target:null};
  if(reference.status!=='scalar')return {status:'unresolved_metadata',target:null};
  const value=reference.value;
  if(value.includes('://')){
    let url;try{url=new URL(value);}catch{return {status:'unresolved_metadata',target:null};}
    if(url.origin+url.pathname!==specification.uri||url.search||url.username||url.password)
      return {status:'external_reference',target:null,uri:value};
    if(!url.hash)return {status:'unresolved_metadata',target:null};
    try{return {target:decodeURIComponent(url.hash.slice(1))};}
    catch{return {status:'unresolved_metadata',target:null};}
  }
  return {target:value.startsWith('#')?value.slice(1):value};
}

/** All catalog rows survive; a feature's declared references never certify its
 * entire meaning, applicability, optionality, or edition membership. */
export function buildTest262EditionAudit({catalog,sources,specification,bytes,python='python3'}={}){
  validateTest262Catalog(catalog);
  verifyEcma262SpecificationBytes(bytes,specification);
  const inventory=extractEcma262HtmlInventory(bytes,{python});
  const anchors=new Map(inventory.anchors.map(row=>[row.id,row]));
  const catalogPaths=new Set(catalog.files.map(file=>file.path));
  const references=new Map(),routing=new Map(),fileIdentities=new Map();
  for(const file of catalog.files.filter(file=>file.kind==='test')){
    const value=sources?.[file.path],source=typeof value==='string'?Buffer.from(value):value;
    if(!(source instanceof Uint8Array)||sha(source)!==file.sha256)
      throw new TypeError('Edition audit requires the exact catalog test bytes: '+file.path);
    let fields,error=null;
    try{const original=text(source);routing.set(file.path,parseTest262Header(original));
      fields=test262SpecificationReference(original);}
    catch(problem){fields={};error=problem.message;}
    const target=targetFor(fields.esid,specification),anchor=target.target?anchors.get(target.target):null,
      matches=anchor?.sections??[];
    const status=error?'unresolved_metadata':target.status??
      (anchor?.occurrences===1?'resolved_anchor':anchor?'ambiguous_anchor':'anchor_absent');
    references.set(file.path,{metadata:fields,status,target:target.target,
      sections:matches,...(target.uri?{externalUri:target.uri}:{}),...(error?{reason:error}:{})});
    fileIdentities.set(file.path,file.sha256);
  }
  const modes=new Map();
  const reviewedInputs=new Set();
  for(const variant of catalog.variants){
    const {id,...identity}=variant,metadata=routing.get(variant.path);
    const expectedHarness=metadata&&!metadata.flags.includes('raw')?[...new Set(['assert.js','sta.js',
      ...(metadata.flags.includes('async')?['doneprintHandle.js']:[]),...metadata.includes])]
      .map(name=>({path:'harness/'+name,sha256:catalogPaths.has('harness/'+name)?
        sha(sources['harness/'+name]):null})):[];
    if(!references.has(variant.path)||variant.sourceDigest!==fileIdentities.get(variant.path)||
       id!==conformanceDigest({suiteRevision:catalog.suiteRevision,profile:catalog.profile,...identity})||
       (metadata?conformanceDigest(metadata)!==conformanceDigest(variant.metadata):variant.metadata!==null)||
       conformanceDigest(variant.harness)!==conformanceDigest(expectedHarness))
      throw new TypeError('Edition audit variant contradicts its pinned source or profile: '+variant.path);
    if(!modes.has(variant.path))modes.set(variant.path,[]);
    modes.get(variant.path).push(variant.mode);
    const evidence=variant.classification.evidence;
    for(const input of evidence?.sourceInputs??[]){
      if(reviewedInputs.has(input.path))continue;
      const value=sources?.[input.path],source=typeof value==='string'?Buffer.from(value):value;
      if(!(source instanceof Uint8Array)||sha(source)!==input.sha256)
        throw new TypeError('Membership audit requires the exact reviewed source input bytes: '+input.path);
      reviewedInputs.add(input.path);
    }
    if(evidence&&(evidence.editionSpecification.uri!==specification.uri||
      evidence.editionSpecification.sha256!==specification.sha256))
      throw new TypeError('Membership review names a different pinned edition specification: '+variant.path);
    for(const obligation of evidence?.normativeObligations??[]){
      if(obligation.basis==='edition'&&obligation.clauseIds.some(id=>!inventory.sections.some(section=>section.id===id)))
        throw new TypeError('Membership review cites a clause absent from the exact pinned edition: '+variant.path);
    }
  }
  for(const path of references.keys()){
    const expected=routing.has(path)?test262VariantModes(routing.get(path)):['unclassified'];
    if(!modes.has(path)||conformanceDigest(modes.get(path))!==conformanceDigest(expected))
      throw new TypeError('Edition audit requires every declared variant mode: '+path);
  }
  const rows=catalog.variants.map(variant=>({id:variant.id,path:variant.path,mode:variant.mode,
    sourceDigest:variant.sourceDigest,features:variant.metadata?.features??[],
    expectedOutcome:variant.expectedOutcome,
    reference:references.get(variant.path),
    scopeReview:variant.path.startsWith('test/intl402/')?'separate-ecma402-pin-required':
      variant.path.startsWith('test/annexB/')?'annex-b-applicability-review':'core-or-extension-review',
    classification:variant.classification}));
  const statuses={},profiles={},features=new Map(),referencedSections=new Set();
  const membership={},releaseRequirement={required:0,notRequired:0},scopeByMembership={};
  const variantModes={},expectedOutcomes={normal:0,negativePhases:{}},fileMembership={};
  for(const row of rows){
    statuses[row.reference.status]=(statuses[row.reference.status]??0)+1;
    profiles[row.scopeReview]=(profiles[row.scopeReview]??0)+1;
    const classification=row.classification;
    membership[classification.membership]=(membership[classification.membership]??0)+1;
    releaseRequirement[classification.requiredForThisRelease?'required':'notRequired']++;
    if(!scopeByMembership[row.scopeReview])scopeByMembership[row.scopeReview]={};
    scopeByMembership[row.scopeReview][classification.membership]=
      (scopeByMembership[row.scopeReview][classification.membership]??0)+1;
    variantModes[row.mode]=(variantModes[row.mode]??0)+1;
    const expected=row.expectedOutcome;
    if(expected?.kind==='error')
      expectedOutcomes.negativePhases[expected.phase]=(expectedOutcomes.negativePhases[expected.phase]??0)+1;
    else expectedOutcomes.normal++;
    if(Object.hasOwn(fileMembership,row.path)&&
      conformanceDigest(fileMembership[row.path])!==conformanceDigest(classification))
      throw new TypeError('Edition audit variants disagree on source-file classification: '+row.path);
    fileMembership[row.path]=classification;
    row.reference.sections.forEach(section=>referencedSections.add(section));
    for(const name of row.features){
      if(!features.has(name))features.set(name,{feature:name,variants:0,referenceDispositions:{},targets:new Set(),sections:new Set()});
      const feature=features.get(name);feature.variants++;
      feature.referenceDispositions[row.reference.status]=(feature.referenceDispositions[row.reference.status]??0)+1;
      if(row.reference.target)feature.targets.add(row.reference.target);
      row.reference.sections.forEach(section=>feature.sections.add(section));
    }
  }
  const testFilesByMembership={};
  for(const classification of Object.values(fileMembership))
    testFilesByMembership[classification.membership]=(testFilesByMembership[classification.membership]??0)+1;
  const body={schema:'test262-edition-reference-audit/1',catalogDigest:catalog.digest,
    suiteRevision:catalog.suiteRevision,specification,inventory,
    summary:{catalogVariants:catalog.variants.length,auditedVariants:rows.length,testFiles:references.size,
      referenceDispositions:statuses,scopeReview:profiles,featureTags:features.size,
      editionMembership:membership,releaseRequirement,
      scopeReviewByEditionMembership:scopeByMembership,
      unresolvedEditionMembership:membership.unclassified??0,
      sourceFilesByEditionMembership:testFilesByMembership,variantModes,expectedOutcomes,
      sections:inventory.sections.length,sectionsReferenced:referencedSections.size,
      sectionsWithoutDirectTestReference:inventory.sections.filter(section=>!referencedSections.has(section.id)).length},
    features:[...features.values()].sort((a,b)=>a.feature.localeCompare(b.feature)).map(feature=>({...feature,
      targets:[...feature.targets].sort(),sections:[...feature.sections].sort()})),
    rows,claims:{editionMembershipCertified:false,applicabilityCertified:false,conformance:false},
    limits:['A resolved anchor is a source reference, not proof that all semantics of the test belong to this edition.',
      'An absent anchor may be renamed, stale or outside the edition; it is not automatically an exclusion.',
      'Unreferenced specification clauses are not automatically untested; tests may cite a parent or omit esid.',
      'Feature counts overlap. All original variants and classifications are retained; no execution evidence is copied.']};
  return {...body,digest:conformanceDigest(body)};
}
