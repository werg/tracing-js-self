// Narrow source/grammar annotations for selected Test262 parse failures.
// These annotations describe relation to one pinned grammar, not conformance.
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {tokenizer} from 'acorn';
import {validateTest262Catalog,conformanceDigest} from './test262-catalog.js';
import {verifyEcma262SpecificationBytes} from './test262-specification.js';
import {validateOriginalTest262Report} from './test262-campaign.js';
import {gitBlobSha} from '../test262-baseline.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const REQUIRED_PRODUCTIONS=Object.freeze({
  ImportDeclaration:{id:'prod-ImportDeclaration',sha256:'fad54aff3713cc675476b177849a85619023e43e78dbdc8ebbaf0905951c6eae'},
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
    out[name]={id:expected.id,sha256:digest,bytes:production.length};
  }
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
  const rows=catalog.variants.map((variant,index)=>({variant,campaign:campaignById.get(runCatalog.variants[index].id),
    scopeAnnotation:annotations.get(runCatalog.variants[index].id)??{status:'unclassified',
      reason:variant.metadata?.features?.includes('import-defer')?
        'feature tag alone does not establish grammar scope':'not a matched parse-failure row'}
  }));
  const tally={};for(const row of rows){const key=row.scopeAnnotation.status;tally[key]=(tally[key]??0)+1;}
  const body={schema:'test262-scope-annotations/1',catalogDigest:catalog.digest,
    test262Revision:catalog.suiteRevision,campaignCatalogDigest:triage.catalogDigest,
    campaignProducerRevision:campaign.campaign.implementation.producerRevision,
    ...(toolIdentity?{toolIdentity}:{}),specification,productions,summary:{catalogVariants:catalog.variants.length,annotatedRows:rows.length,
      parseFailureRows:triage.failedCases.parseStatic.length,scope:tally,
      importDeferFeatureRows:catalog.variants.filter(row=>row.metadata?.features?.includes('import-defer')).length},
    rows,claims:{editionMembershipCertified:false,conformance:false,denominatorRowsRemoved:0},
    limits:['Annotations are limited to exact parser failure locations, pinned grammar production bytes, and exact frozen Test262 source bytes.',
      'Feature tags do not establish edition membership; unmatched variants remain unclassified.',
      'Outside-pinned-grammar means only that the matched source form is absent from the pinned production set; it is not a conformance or support claim.']};
  return {...body,digest:conformanceDigest(body)};
}
