// Derived experimental views of one validated record. These are not alternative
// decoders and never authorize state transitions or alter the canonical codec.
import {validateTerm} from './ir.js';
import {OPERATION_REGISTRY} from './operations.js';
import {encodeAlgorithmValue,encodeAlgorithmTerm,encodeAlgorithmRecord,
  decodeAlgorithmRecord,validateAlgorithmRecord} from './trace-codec.js';
import {renderAlgorithmRecord} from './render-algorithm.js';
import {hashAlgorithmData} from './program.js';

export const NOTATION_ARMS=Object.freeze(['canonical','formal','hybrid','prose']);
const value=encodeAlgorithmValue;
function termText(term){
  if(term.op==='literal')return value(term.value);
  if(term.op==='input')return '$'+term.id;
  if(term.op==='ref')return '%'+term.id;
  if(term.op==='project')return 'own_data('+termText(term.object)+', '+JSON.stringify(term.key)+')';
  if(term.op==='fold_left')return encodeAlgorithmTerm(term);
  const operation=OPERATION_REGISTRY[term.op];
  if(!operation||!Array.isArray(term.args))return encodeAlgorithmTerm(term);
  const args=term.args.map(termText);
  if(operation.operator==='?:')return '('+args[0]+' ? '+args[1]+' : '+args[2]+')';
  if(operation.arity===2&&operation.operator)return '('+args[0]+' '+operation.operator+' '+args[1]+')';
  if(operation.arity===1&&operation.operator)return '('+operation.operator+
    (/^[a-z]/.test(operation.operator)?' ':'')+args[0]+')';
  return encodeAlgorithmTerm(term);
}
export function renderFormalTerm(term){validateTerm(term);return termText(term);}
export function renderNotationRecord(record,{arm='hybrid'}={}){
  if(!NOTATION_ARMS.includes(arm))throw new TypeError('Unknown notation arm');
  if(typeof record==='string')record=decodeAlgorithmRecord(record);
  validateAlgorithmRecord(record);
  if(arm==='canonical')return encodeAlgorithmRecord(record);
  if(arm==='prose')return renderAlgorithmRecord(record);
  const formal=arm==='formal';
  switch(record.kind){
    case 'compute':return record.id+' = '+termText(record.term)+' => '+value(record.result);
    case 'request':return formal?record.id+' = request('+JSON.stringify(record.boundary)+', '+
      JSON.stringify(record.operation)+', ['+record.arguments.map(value).join(', ')+'])':
      'request '+record.id+' at '+record.boundary+': '+record.operation+'('+record.arguments.map(value).join(', ')+')';
    case 'observe':return formal?record.id+' = observe('+record.request+', '+JSON.stringify(record.status)+
      (record.status==='completed'?'':', '+value(record.value))+')':
      'observe '+record.request+' as '+record.id+' => '+record.status+
      (record.status==='completed'?'': ' '+value(record.value));
    case 'write':return (record.present?'write ':'delete ')+value(record.object)+'['+JSON.stringify(record.key)+']'+
      (record.present?' = '+value(record.value):' (absent; prior claim '+value(record.value)+')');
    case 'return':case 'throw':return record.kind+' '+value(record.value);
    case 'suspend':return (formal?'suspend(':'wait [')+record.requests.join(', ')+
      (formal?'; live=[':']; retain [')+record.live.join(', ')+(formal?'])':']');
    default:throw new TypeError('Missing derived notation for '+record.kind);
  }
}
export function notationViews(records){
  if(!Array.isArray(records)||records.length===0)throw new TypeError('Records are required');
  const canonical=records.map(record=>typeof record==='string'?decodeAlgorithmRecord(record):record);
  canonical.forEach(validateAlgorithmRecord);
  return {schema:'semantic-notation-views/1',semanticDigest:hashAlgorithmData(canonical),
    canonical:canonical.map(encodeAlgorithmRecord).join('\n'),
    arms:Object.fromEntries(NOTATION_ARMS.map(arm=>[arm,canonical.map(record=>
      renderNotationRecord(record,{arm})).join('\n')])),
    qualification:'Derived views of identical records; only canonical records are executable'};
}
