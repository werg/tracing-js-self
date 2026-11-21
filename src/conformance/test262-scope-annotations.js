// Narrow source/grammar annotations for selected Test262 parse failures.
// These annotations describe relation to one pinned grammar, not conformance.
import {createHash,randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,linkSync,mkdirSync,openSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {tokenizer} from 'acorn';
import {validateTest262Catalog,conformanceDigest} from './test262-catalog.js';
import {verifyEcma262SpecificationBytes} from './test262-specification.js';
import {validateOriginalTest262Report} from './test262-campaign.js';
import {gitBlobSha} from '../test262-baseline.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const REQUIRED_PRODUCTIONS=Object.freeze({
  ImportDeclaration:{id:'prod-ImportDeclaration',sha256:'fad54aff3713cc675476b177849a85619023e43e78dbdc8ebbaf0905951c6eae'},
  ImportClause:{id:'prod-ImportClause',sha256:'b40ecb42636c6a8635ea5ea97a43dc539dd90b5fb255c749091f3ffd7b1caa5b'},
  ImportedDefaultBinding:{id:'prod-ImportedDefaultBinding',sha256:'b9270a73d40b1aea3f1ccf6d60c9e85c21558f55652df6b547130c58a9ba5574'},
  ImportedBinding:{id:'prod-ImportedBinding',sha256:'937efafed1f91762b2901299d9954deacdd27ed3c6ecc90a8a2e7c4ae712315b'},
  BindingIdentifier:{id:'prod-BindingIdentifier',sha256:'6479226d61448558f30c46b903442220584535dff9851ea980403bbb74853df2'},
  Identifier:{id:'prod-Identifier',sha256:'85a2b8ad3a750b129d3101820baa402b14e0d557b736de48bbc39e46630f89db'},
  ReservedWord:{id:'prod-ReservedWord',sha256:'1f9783d7296326d5111ce7d5962360192d4d832ef6062ce386846718f07cd3e9'},
  ImportMeta:{id:'prod-ImportMeta',sha256:'a911dead533a77a79f419711b46496a58a20456529dae744a8043761e386bd03'},
  ImportCall:{id:'prod-ImportCall',sha256:'e5035f9df2c3f6ee22871ea0a78e8dd036f1457c69e9b4ec8403d720aeccc848'}
});

export function extractImportDeferGrammarEvidence(bytes){
  const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes),out={};
  for(const [name,expected] of Object.entries(REQUIRED_PRODUCTIONS)){
    const re=new RegExp(`<emu-production\\s+name="${name}"[^>]*\\bid="${expected.id}"[^>]*>[\\s\\S]*?<\\/emu-production>`,'g');
    const matches=[...html.matchAll(re)];
    if(matches.length!==1)throw new TypeError(`Pinned specification must contain one ${name} definition`);
    const production=Buffer.from(matches[0][0]);
    const digest=sha(production);
    if(digest!==expected.sha256)throw new TypeError(`Pinned ${name} production bytes differ from reviewed grammar`);
    const textContent=markup=>markup.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
      .replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
    out[name]={id:expected.id,sha256:digest,bytes:production.length,
      terminals:[...matches[0][0].matchAll(/<emu-t\b[^>]*>([\s\S]*?)<\/emu-t>/g)].map(match=>textContent(match[1])),
      nonterminals:[...matches[0][0].matchAll(/<emu-nt\b[^>]*>([\s\S]*?)<\/emu-nt>/g)].map(match=>textContent(match[1]))};
  }
  const includes=(production,name)=>production.nonterminals.some(value=>value===name||value.startsWith(name+' '));
  const importBindingRoute=includes(out.ImportDeclaration,'ImportClause')&&includes(out.ImportClause,'ImportedDefaultBinding')&&
    includes(out.ImportedDefaultBinding,'ImportedBinding')&&includes(out.ImportedBinding,'BindingIdentifier')&&
    includes(out.BindingIdentifier,'Identifier')&&!out.ReservedWord.terminals.includes('defer');
  if(!importBindingRoute)throw new TypeError('Pinned grammar does not contain the reviewed default-import binding route');
  out.annualDefaultImportBindingRoute={productions:['ImportDeclaration','ImportClause','ImportedDefaultBinding',
    'ImportedBinding','BindingIdentifier','Identifier','ReservedWord'],deferIsReservedWord:false};
  return out;
}

function locationFrom(reason){
  const match=/\((\d+):(\d+)\)$/.exec(reason??'');
  return match?{line:Number(match[1]),column:Number(match[2])}:null;
}

function sourceTokens(source){
  const tokens=[];
  try{
    const scanner=tokenizer(source,{ecmaVersion:2026,sourceType:'module'});
    for(;;){const token=scanner.getToken();tokens.push(token);if(token.type.label==='eof')return tokens;}
  }catch{return null;}
}

/** Record source forms without treating a feature annotation as grammar proof. */
function importDeferSourceForms(source){
  const tokens=sourceTokens(source);
  if(!tokens)return {complete:false,forms:[]};
  const forms=new Set();
  for(let index=0;index<tokens.length;index++){
    if(tokens[index].type.label!=='import')continue;
    const next=tokens[index+1],after=tokens[index+2],third=tokens[index+3];
    if(next?.type.label==='name'&&next.value==='defer'){
      if(after?.type.label==='*')forms.add('static-import-defer');
      else if(after?.type.label==='name'&&after.value==='from'||after?.type.label===',')
        forms.add('default-binding-named-defer');
    }
    if(next?.type.label==='.'&&after?.type.label==='name'&&after.value==='defer')
      forms.add('import-defer-member');
    if(next?.type.label==='.'&&after?.value==='defer'&&third?.type.label==='(')
      forms.add('dynamic-import-defer');
  }
  return {complete:true,forms:[...forms].sort()};
}

function reviewImportDeferSource(variant,campaignRow,sources,filesByPath){
  const paths=variant.mode==='module'?variant.dependencies?.files?.map(file=>file.path)??[variant.path]:[variant.path];
  if(!paths.includes(variant.path))paths.unshift(variant.path);
  const evidence=[],seen=new Set();let complete=variant.mode!=='module'||variant.dependencies?.status==='complete';
  for(const path of paths){
    if(seen.has(path))continue;
    seen.add(path);
    const declared=variant.mode==='module'?variant.dependencies?.files?.find(file=>file.path===path):null;
    const file=filesByPath.get(path),value=sources?.[path],source=typeof value==='string'?Buffer.from(value):value;
    if(!(source instanceof Uint8Array)||!file||sha(source)!==file.sha256||gitBlobSha(source)!==file.gitBlobSha||
       declared&&declared.sha256!==file.sha256){complete=false;continue;}
    let text;
    try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source);}
    catch{complete=false;continue;}
    const scan=importDeferSourceForms(text);
    if(!scan.complete)complete=false;
    if(scan.forms.length)evidence.push({path,sourceDigest:file.sha256,forms:scan.forms});
  }
  const forms=[...new Set(evidence.flatMap(entry=>entry.forms))].sort();
  const status=forms.includes('static-import-defer')||forms.includes('dynamic-import-defer')||forms.includes('import-defer-member')?
      'proposal-grammar-observed':forms.includes('default-binding-named-defer')?
        'annual-grammar-overlap-observed':complete?'tag-without-matching-source-grammar':'source-closure-incomplete';
  return {status,membership:'unclassified',dependencyClosureComplete:complete,
    parseStaticStatus:campaignRow?.stages?.parseStatic?.status??'unavailable',
    parseObservation:campaignParseObservation(variant,campaignRow),
    dependencyClosure:variant.mode==='module'?variant.dependencies?.status??'unresolved':'not-required',forms,evidence};
}

function campaignParseObservation(variant,campaignRow){
  const stage=campaignRow?.stages?.parseStatic;
  if(!stage||!['passed','failed'].includes(stage.status))return {kind:'unobserved',disposition:stage?.status??'unavailable'};
  const attempt=campaignRow.attempts?.find(row=>row.stage==='parseStatic'&&row.sequence===stage.attempt),
    evidence=attempt?.evidence,expected=variant.metadata?.negative?.phase==='parse'?
      variant.metadata.negative.type:null;
  if(!evidence||evidence.phase!=='parse')return {kind:'unclassified',disposition:stage.status};
  if(stage.status==='passed'&&expected&&evidence.parseOnly===true&&evidence.errorType===expected)
    return {kind:'expected-parse-negative-observed',disposition:stage.status,expectedErrorType:expected,
      observedErrorType:evidence.errorType,parseOnly:evidence.parseOnly};
  if(stage.status==='passed'&&!expected&&evidence.parseOnly===false&&evidence.errorType===null)
    return {kind:'source-parsed',disposition:stage.status,expectedErrorType:null,
      observedErrorType:null,parseOnly:evidence.parseOnly};
  if(stage.status==='failed'&&evidence.errorType==='SyntaxError')
    return {kind:'unexpected-parse-error',disposition:stage.status,expectedErrorType:expected,
      observedErrorType:evidence.errorType,parseOnly:evidence.parseOnly??null};
  return {kind:'unclassified',disposition:stage.status,expectedErrorType:expected,
    observedErrorType:evidence.errorType??null,parseOnly:evidence.parseOnly??null};
}

/** Classify only exact parse errors whose reported token is matched in original source. */
export function classifyImportDeferParseFailure(row,source,productionEvidence){
  if(!row||row.stage!=='parseStatic'||row.status!=='failed'||row.errorType!=='SyntaxError'||
    !Array.isArray(row.features)||!row.features.includes('import-defer')||typeof source!=='string')
    return {status:'unclassified',reason:'failure metadata or original source is incomplete'};
  const loc=locationFrom(row.reason);
  if(!loc)return {status:'unclassified',reason:'parser error has no exact line and column'};
  const lines=source.replace(/\r\n?/g,'\n').split('\n'),line=lines[loc.line-1];
  if(typeof line!=='string'||loc.column<0||loc.column>=line.length)
    return {status:'unclassified',reason:'parser location is outside the original source'};
  const normalized=source.replace(/\r\n?/g,'\n'),lineStart=lines.slice(0,loc.line-1).reduce((sum,item)=>sum+item.length+1,0),
    offset=lineStart+loc.column,tokens=sourceTokens(normalized),index=tokens?.findIndex(token=>token.start===offset)??-1;
  if(row.reason.startsWith('Unexpected parser SyntaxError: Unexpected token')&&
    productionEvidence.ImportDeclaration&&line[loc.column]==='*'&&
    /^\s*import\s+defer\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+(['"]).+\1(?:\s+with\s+\{[^\n]*\})?\s*;?\s*$/.test(line)&&
    index>=2&&tokens[index].type.label==='*'&&tokens[index-1].value==='defer'&&tokens[index-2].type.label==='import')
    return {status:'outside-pinned-grammar',rule:'static-import-defer',location:loc,
      evidence:['ImportDeclaration']};
  if(row.reason.startsWith("Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta'")&&
    productionEvidence.ImportMeta&&productionEvidence.ImportCall&&line[loc.column]==='d'&&
    index>=2&&tokens[index].value==='defer'&&tokens[index-1].type.label==='.'&&
    tokens[index-2].type.label==='import'&&tokens[index+1]?.type.label==='('&&
    !['.','?.'].includes(tokens[index-3]?.type.label))
    return {status:'outside-pinned-grammar',rule:'import-defer-meta-member',location:loc,
      evidence:['ImportMeta','ImportCall']};
  return {status:'unclassified',reason:'source token and pinned-grammar rule do not both match'};
}

/** Preserve every frozen variant; attach a narrow note only to proven parse failures. */
export function assertNewScopeOutput(path){
  if(typeof path!=='string'||!path)throw new TypeError('Scope annotation output path is required');
  if(existsSync(path))throw new TypeError('Scope annotation output must be new');
  return true;
}

/** Publish immutable evidence with an atomic no-replace hard link. */
export function writeNewScopeReport(path,bytes,{beforePublish=()=>{}}={}){
  assertNewScopeOutput(path);
  if(!(bytes instanceof Uint8Array))throw new TypeError('Scope report bytes are required');
  mkdirSync(dirname(path),{recursive:true});
  const temporary=path+'.tmp-'+randomUUID();let descriptor;
  try{
    descriptor=openSync(temporary,'wx',0o600);
    writeFileSync(descriptor,bytes);fsyncSync(descriptor);closeSync(descriptor);descriptor=undefined;
    beforePublish();
    linkSync(temporary,path);
  }finally{
    if(descriptor!==undefined)closeSync(descriptor);
    unlinkSync(temporary);
  }
  return path;
}

export function buildTest262ScopeAnnotations({catalog,campaign,triage,specification,bytes,sources,toolIdentity}={}){
  validateTest262Catalog(catalog);
  verifyEcma262SpecificationBytes(bytes,specification);
  if(!campaign?.profile?.specification||
    conformanceDigest(campaign.profile.specification)!==conformanceDigest(specification))
    throw new TypeError('Campaign-declared ECMA-262 profile differs from exact pinned specification bytes');
  const productions=extractImportDeferGrammarEvidence(bytes);
  if(campaign?.schema!=='original-test262-campaign-report/1'||
    campaign.baseCatalogDigest!==catalog.digest||campaign.catalogDigest!==triage?.catalogDigest||
    campaign.campaign?.catalogDigest!==campaign.catalogDigest||
    triage?.schema!=='test262-module-campaign-triage/1'||
    !Array.isArray(triage.failedCases?.parseStatic)||!Array.isArray(campaign.campaign.rows))
    throw new TypeError('Scope annotation requires retained parse failure rows');
  const validated=validateOriginalTest262Report(campaign,{baseCatalog:catalog,
    implementation:campaign.campaign.implementation});
  const runCatalog=validated.catalog;
  const byId=new Map(catalog.variants.map(row=>[row.id,row]));
  const runById=new Map(runCatalog.variants.map((row,index)=>[row.id,{variant:row,base:catalog.variants[index]}]));
  const campaignById=new Map(campaign.campaign.rows.map(row=>[row.id,row]));
  if(campaign.campaign.rows.length!==catalog.variants.length||campaignById.size!==catalog.variants.length)
    throw new TypeError('Campaign must preserve every frozen catalog variant exactly once');
  for(const runVariant of runCatalog.variants){
    const run=campaignById.get(runVariant.id);
    if(!run||run.path!==runVariant.path||run.mode!==runVariant.mode)
      throw new TypeError('Campaign identity differs from its frozen catalog variant');
  }
  const failedParseIds=campaign.campaign.rows.filter(row=>row.stages?.parseStatic?.status==='failed')
    .map(row=>row.id).sort();
  const triageParseIds=triage.failedCases.parseStatic.map(row=>row.id).sort();
  if(failedParseIds.length!==triageParseIds.length||failedParseIds.some((id,index)=>id!==triageParseIds[index]))
    throw new TypeError('Triage must retain every original parse failure exactly once');
  const annotations=new Map();
  for(const failure of triage.failedCases.parseStatic){
    const linked=runById.get(failure.id),variant=linked?.base;
    const run=campaignById.get(failure.id),parse=run?.stages?.parseStatic;
    if(!variant||linked.variant.path!==failure.path||!byId.has(variant.id)||
      variant.path!==failure.path||parse?.status!=='failed'||parse.reason!==failure.reason||
      failure.stage!=='parseStatic'||failure.status!=='failed'||failure.errorType!=='SyntaxError')
      throw new TypeError('Parse failure does not match its frozen catalog identity');
    const source=sources?.[failure.path];
    if(!(source instanceof Uint8Array)||sha(source)!==variant.sourceDigest||gitBlobSha(source)!==variant.gitBlobSha)
      throw new TypeError('Scope annotation requires exact original Test262 bytes: '+failure.path);
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source);
    const result=classifyImportDeferParseFailure({...failure,features:variant.metadata?.features??[]},text,productions);
    annotations.set(failure.id,{originalFailure:{stage:failure.stage,status:failure.status,
      errorType:failure.errorType,phase:failure.phase,reason:failure.reason},...result});
  }
  const filesByPath=new Map(catalog.files.map(file=>[file.path,file]));
  const importDeferReviews=new Map();
  for(let index=0;index<catalog.variants.length;index++){
    const variant=catalog.variants[index];
    if(variant.metadata?.features?.includes('import-defer'))
      importDeferReviews.set(runCatalog.variants[index].id,
        reviewImportDeferSource(variant,campaignById.get(runCatalog.variants[index].id),sources,filesByPath));
  }
  const rows=catalog.variants.map((variant,index)=>({variant,campaign:campaignById.get(runCatalog.variants[index].id),
    sourceReview:importDeferReviews.get(runCatalog.variants[index].id)??null,
    scopeAnnotation:annotations.get(runCatalog.variants[index].id)??{status:'unclassified',
      reason:variant.metadata?.features?.includes('import-defer')?
        'feature tag alone does not establish grammar scope':'not a matched parse-failure row'}
  }));
  const tally={};for(const row of rows){const key=row.scopeAnnotation.status;tally[key]=(tally[key]??0)+1;}
  const importDeferRows=rows.filter(row=>row.sourceReview!==null),sourceReviewTally={},parseStatusTally={},
    parseObservationTally={};
  for(const row of importDeferRows){
    const review=row.sourceReview.status,parse=row.sourceReview.parseStaticStatus;
    sourceReviewTally[review]=(sourceReviewTally[review]??0)+1;
    parseStatusTally[parse]=(parseStatusTally[parse]??0)+1;
    const observation=row.sourceReview.parseObservation.kind;
    parseObservationTally[observation]=(parseObservationTally[observation]??0)+1;
  }
  const body={schema:'test262-scope-annotations/1',catalogDigest:catalog.digest,
    test262Revision:catalog.suiteRevision,campaignCatalogDigest:triage.catalogDigest,
    campaignProducerRevision:campaign.campaign.implementation.producerRevision,
    ...(toolIdentity?{toolIdentity}:{}),specification,productions,summary:{catalogVariants:catalog.variants.length,annotatedRows:rows.length,
      parseFailureRows:triage.failedCases.parseStatic.length,scope:tally,
      importDeferFeatureRows:importDeferRows.length,
      importDeferSourceReview:{variants:importDeferRows.length,parseStaticStatuses:parseStatusTally,
        parseObservations:parseObservationTally,sourceEvidence:sourceReviewTally}},
    rows,claims:{editionMembershipCertified:false,conformance:false,denominatorRowsRemoved:0},
    limits:['Annotations are limited to exact parser failure locations, pinned grammar production bytes, and exact frozen Test262 source bytes.',
      'Feature tags do not establish edition membership; unmatched variants remain unclassified.',
      'Import-defer source reviews are source-form observations only; neither a proposal-shaped form nor an ordinary binding form changes membership or a retained campaign status.',
      'Outside-pinned-grammar means only that the matched source form is absent from the pinned production set; it is not a conformance or support claim.']};
  return {...body,digest:conformanceDigest(body)};
}
