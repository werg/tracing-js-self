// Controlled readings from the typed core and its operation registry. Readings
// are explanatory views; only the strict codec/checker authorize execution.
import {validateAlgorithm,validateTerm,assertAlgorithmValue} from './ir.js';
import {OPERATION_REGISTRY} from './operations.js';
import {validateAlgorithmRecord,decodeAlgorithmRecord,encodeAlgorithmValue} from './trace-codec.js';

function valueReading(value){
  assertAlgorithmValue(value);
  return value[0]==='ref'?'object '+value[1]:encodeAlgorithmValue(value);
}
function termReading(term){
  if(term.op==='literal')return valueReading(term.value);
  if(term.op==='input')return 'input '+term.id;
  if(term.op==='ref')return 'value '+term.id;
  if(term.op==='project')return 'the own data field '+JSON.stringify(term.key)+' of '+termReading(term.object)+
    ' (undefined if absent)';
  if(term.op==='fold_left')return 'the ordered accumulation of '+termReading(term.input)+
    ', starting at '+termReading(term.initial)+', adding each number in ascending index order';
  const operation=OPERATION_REGISTRY[term.op];
  if(typeof operation?.reading!=='string')throw new TypeError('Missing controlled reading for '+term.op);
  const argumentsText=term.args.map(child=>{
    const reading=termReading(child);
    return ['literal','input','ref'].includes(child.op)?reading:'('+reading+')';
  });
  return operation.reading.replace(/\{([0-9]+)\}/g,(_,index)=>argumentsText[Number(index)]);
}
export function renderAlgorithmTerm(term){validateTerm(term);return termReading(term);}

export function renderAlgorithmRecord(record){
  if(typeof record==='string')record=decodeAlgorithmRecord(record);
  validateAlgorithmRecord(record);
  switch(record.kind){
    case 'compute':
      if(record.term.op==='fold_left')return 'Starting at '+termReading(record.term.initial)+
        ', add each number in '+termReading(record.term.input)+' in ascending index order. '+
        'The result is '+valueReading(record.result)+'; bind it as '+record.id+'.';
      return 'Compute '+record.id+' as '+termReading(record.term)+'. The result is '+valueReading(record.result)+'.';
    case 'request':return 'Request '+record.operation+' with '+
      (record.arguments.length?'arguments '+record.arguments.map(valueReading).join(', '):'no arguments')+
      ' at boundary '+record.boundary+'. Correlate the response as '+record.id+'.';
    case 'observe':
      if(record.status==='completed')return 'The environment reports request '+record.request+
        ' completed without a returned value; bind its completion as '+record.id+'.';
      return 'The environment reports request '+record.request+(record.status==='rejected'?' rejected with ':' returned ')+
        valueReading(record.value)+'; bind it as '+record.id+'.';
    case 'write':return record.present?'Set the own data field '+JSON.stringify(record.key)+' of '+
      valueReading(record.object)+' to '+valueReading(record.value)+'.':
      'Remove the own data field '+JSON.stringify(record.key)+' from '+valueReading(record.object)+'.';
    case 'return':return 'Return '+valueReading(record.value)+'.';
    case 'throw':return 'Throw '+valueReading(record.value)+'.';
    case 'suspend':return 'Wait for '+record.requests.join(', ')+'. '+
      (record.live.length?'Retain live values '+record.live.join(', ')+'.':'No computed values are live.');
  }
}

/** A program reading has no future observed values and makes no result claims. */
export function renderAlgorithm(core){
  validateAlgorithm(core);
  return core.steps.map(step=>{
    switch(step.kind){
      case 'compute':return 'Compute '+step.id+' as '+termReading(step.term)+'.';
      case 'request':return 'Request '+step.operation+' with '+
        (step.arguments.length?'arguments '+step.arguments.map(termReading).join(', '):'no arguments')+
        ' at boundary '+step.boundary+' as '+step.id+'.';
      case 'observe':return 'Wait for the environment to deliver request '+step.request+' as '+step.id+'.';
      case 'write':return step.present?'Set the own data field '+JSON.stringify(step.key)+' of '+
        termReading(step.object)+' to '+termReading(step.value)+'.':
        'Remove the own data field '+JSON.stringify(step.key)+' from '+termReading(step.object)+'.';
      case 'return':return 'Return '+termReading(step.value)+'.';
      case 'throw':return 'Throw '+termReading(step.value)+'.';
      case 'suspend':return 'Wait for '+step.requests.join(', ')+'. '+
        (step.live.length?'Retain live values '+step.live.join(', ')+'.':'No computed values are live.');
    }
  }).join('\n');
}
