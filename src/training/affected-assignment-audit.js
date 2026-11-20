// Read-only susceptibility inventory for the strict getter-only assignment
// defect. This is neither re-admission nor an independent execution oracle.
// It reads the historical pre-state rather than the final graph: a later write
// must not hide an earlier failed [[Set]], and descriptor construction may use
// aliases instead of a recognizable Object.defineProperty source spelling.
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {validateBundle} from '../validation.js';
import {decode} from '../values.js';
import {stringPropertyKey,symbolPropertyKey} from '../property-keys.js';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const own=(object,key)=>Object.hasOwn(object??{},key);
const prototype=object=>own(object,'prototype')?object.prototype:
  object.kind==='array'?'Array.prototype':'Object.prototype';
const definitionWrites=new Set(['DEFINE_LITERAL_PROP','APPEND_ARRAY','CLASS_INITIALIZER',
  'PRIVATE_DEFINE','PRIVATE_SET']);

// Derive strictness from original bytes. Historical bytecode predates the
// strict flag, and a faulty teacher flag is not authority for source mode.
function strictRegions(source){
  const root=parse(source.text,{ecmaVersion:2022,sourceType:source.goal==='module'?'module':'script'});
  const regions=[];
  const directives=body=>{
    for(const statement of body){
      if(typeof statement.directive!=='string')break;
      if(statement.directive==='use strict')return true;
    }
    return false;
  };
  function visit(node,inherited){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){for(const child of node)visit(child,inherited);return;}
    let strict=inherited;
    if(node.type==='Program')strict=strict||root.sourceType==='module'||directives(node.body);
    else if(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))
      strict=strict||(node.body.type==='BlockStatement'&&directives(node.body.body));
    else if(node.type==='ClassBody')strict=true;
    if(node.type==='Program'||node.type==='ClassBody'||
       ['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type))
      regions.push({start:node.start,end:node.end,strict});
    for(const [key,value] of Object.entries(node))
      if(!['start','end','loc'].includes(key))visit(value,strict);
  }
  visit(root,false);
  return regions;
}

function accessorAt(heap,id,key){
  const visited=new Set();
  while(id!==null&&!['Object.prototype','Array.prototype','Function.prototype'].includes(id)){
    if(visited.has(id))return {unknown:'cyclic_prototype'};
    visited.add(id);
    const object=heap[id];
    if(!object)return {unknown:'missing_receiver_or_prototype'};
    if(!['object','array','function'].includes(object.kind))return {unknown:'nonordinary_receiver_or_prototype'};
    if(own(object.properties,key))return {accessor:null};
    if(own(object.accessors,key))return {accessor:object.accessors[key],owner:id};
    id=prototype(object);
  }
  return {accessor:null};
}

/** Inventory one public/private episode or an original owned archive. */
export function auditAffectedAssignments(value,{id=null,producerRevision=null}={}){
  const side=value?.sidecar??null,bundle=side?.archive??
    (value?.manifest?.schema==='semantic-tracing-run/2'?value:null);
  const row={id:id??side?.taskId??side?.sourceFamily??'episode',
    producerRevision:producerRevision??side?.producerRevision??null,
    admission:side?.admission??null,identityDigest:side?.identityDigest??null,
    episodeDigest:value?.public?hash(value.public):null,
    archiveDigest:bundle?hash(bundle):null,
    sourceDigests:bundle?.sources?.map(source=>({sourceId:source.sourceId,digest:hash(source.text)}))??[],
    scope:'executed-strict-getter-only-PUT_PROP',status:'not_audited',
    reason:null,structuralValidation:false,propertyWriteEvents:0,
    affectedEvents:[],uncertainEvents:[],sloppyGetterOnlyEvents:0,
    action:'quarantine_pending_private_evidence',independentRequalification:false};
  if(!bundle){row.reason='Private execution archive unavailable';return row;}
  try{validateBundle(bundle);row.structuralValidation=true;}
  catch(error){
    row.reason='Historical archive failed structural validation: '+error.message;
    row.action='quarantine_invalid_evidence';return row;
  }
  const regions=new Map(),parseErrors=new Map();
  for(const source of bundle.sources){
    try{regions.set(source.sourceId,strictRegions(source));}
    catch(error){parseErrors.set(source.sourceId,error.message);}
  }
  // Only these two tables are needed. Full reconstruction/typed patch checks
  // have already run; scanning never runs a getter or executes guest source.
  const heap=structuredClone(bundle.initialState.heap),frames=structuredClone(bundle.initialState.frames);
  const sites=new Map(bundle.sites.map(site=>[site.siteId,site]));
  const encodedKeys=bundle.manifest.ownedSymbols?.propertyKeys==='owned-property-key/1';
  for(const event of bundle.events){
    if(event.operation==='property.write'){
      row.propertyWriteEvents++;
      const frame=frames[event.invocationId],instruction=bundle.programs[frame?.codeId]?.instructions[frame?.pc];
      const site=sites.get(event.siteId),sourceId=site?.sourceId??event.sourceId;
      const detail={eventId:event.eventId,sourceId,siteId:event.siteId,
        start:site?.start??null,end:site?.end??null};
      const uncertain=reason=>row.uncertainEvents.push({...detail,reason});
      // These exact bytecodes create data/accessor definitions or mutate
      // separate internal slots. They do not execute the ordinary [[Set]]
      // path implicated by the historical defect. Unknown writes still
      // quarantine the audit; a broad property.write label is not enough.
      if(instruction?.siteId===event.siteId&&site&&definitionWrites.has(instruction.op)){
        // Known non-[[Set]] operation, outside this narrow susceptibility scan.
      }else if(instruction?.op!=='PUT_PROP'||instruction.siteId!==event.siteId||!site)
        uncertain('Property write lacks an exact pre-state PUT_PROP site');
      else if(parseErrors.has(sourceId))uncertain('Original source mode could not be parsed: '+parseErrors.get(sourceId));
      else{
        const region=(regions.get(sourceId)??[]).filter(region=>region.start<=site.start&&region.end>=site.end)
          .sort((a,b)=>(a.end-a.start)-(b.end-b.start))[0];
        const [base,key,value]=frame.stack.slice(-3).map(token=>token.value);
        if(!region||!base||!key||!value)uncertain('Missing source region or evaluated assignment operands');
        else if(base[0]!=='ref')uncertain('Nonordinary property receiver is outside this audit');
        else if(!['str','num','bool','null','undefined','bigint','symbol'].includes(key[0]))
          uncertain('Property key requires unsupported coercion');
        else{
          const property=key[0]==='symbol'?symbolPropertyKey(key[1]):encodedKeys?stringPropertyKey(String(decode(key))):String(decode(key)),found=accessorAt(heap,base[1],property);
          if(found.unknown)uncertain(found.unknown);
          else if(found.accessor?.set?.value?.[0]==='undefined'){
            if(!region.strict)row.sloppyGetterOnlyEvents++;
            else row.affectedEvents.push({...detail,receiverId:base[1],descriptorOwnerId:found.owner,
              inherited:base[1]!==found.owner,key:property,rhs:structuredClone(value),
              recordedCompletion:event.completion?.type??'normal',
              recordedErrorType:event.completion?.errorType??null,
              recordedResult:structuredClone(event.result),
              suspectedSilentFailure:!event.completion||event.completion.type!=='throw'});
          }else if(found.accessor&&!Array.isArray(found.accessor.set?.value))
            uncertain('Accessor setter descriptor lacks a tagged value');
        }
      }
    }
    for(const patch of event.stateChanges){
      const table=patch.table==='heap'?heap:patch.table==='frames'?frames:null;
      if(!table)continue;
      if(patch.after===null)delete table[patch.id];
      else table[patch.id]=structuredClone(patch.after);
    }
  }
  if(row.affectedEvents.length){
    row.status='affected_path_observed';row.action='requalify_from_original_source_and_inputs';
    row.reason='Recorded execution attempted a strict write to a getter-only property';
  }else if(row.uncertainEvents.length){
    row.status='incomplete_audit';row.action='quarantine_pending_complete_audit';
    row.reason='One or more executed property writes are outside the auditable boundary';
  }else{
    row.status='no_affected_path_observed';row.action='none_for_this_narrow_audit';
    row.reason='No executed strict getter-only PUT_PROP was found; this is not semantic requalification';
  }
  return row;
}

export function summarizeAffectedAssignments(rows,{inventory=null}={}){
  if(!Array.isArray(rows))throw new TypeError('Audit rows must be an array');
  const ids=rows.map(row=>row.id);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)
    throw new TypeError('Audit rows require unique nonempty identities');
  return {schema:'strict-assignment-affected-inventory/1',
    evidenceKind:'historical-recorded-state-susceptibility-inventory',
    claim:'Narrow executed-path inventory; no corpus contamination or renewed admission is inferred',
    inventory,counts:{rows:rows.length,archivesAvailable:rows.filter(row=>row.archiveDigest).length,
      structurallyValidated:rows.filter(row=>row.structuralValidation).length,
      affectedRows:rows.filter(row=>row.affectedEvents.length).length,
      suspectedSilentFailureRows:rows.filter(row=>row.affectedEvents.some(event=>event.suspectedSilentFailure)).length,
      affectedEvents:rows.reduce((total,row)=>total+row.affectedEvents.length,0),
      notAudited:rows.filter(row=>row.status==='not_audited').length,
      incompleteAudits:rows.filter(row=>row.status==='incomplete_audit'||row.uncertainEvents.length).length,
      noAffectedPathObserved:rows.filter(row=>row.status==='no_affected_path_observed').length},
    requalificationList:rows.filter(row=>row.affectedEvents.length).map(row=>row.id),
    quarantineList:rows.filter(row=>row.status==='not_audited'||row.uncertainEvents.length).map(row=>row.id),
    historicalArtifactsModified:false,nativeAdmission:false,rows};
}
