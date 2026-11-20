// Source-free outcome tasks authored from semantic family descriptions. Expected
// outputs come from independent V8 reference execution, never from the trace
// renderer or a model. Fixture provenance stays outside the public survey.
import {LANGUAGE_EXPANSION_FAMILIES} from './benchmark.js';
import {SEMANTIC_COMPREHENSION_TASKSET} from '../semantic-equivalence/comprehension.js';
import {independentBenchmarkOutcome} from '../../src/semantic/expansion-benchmark.js';
import {encodeAlgorithmValue} from '../../src/semantic/trace-codec.js';
import {encodeAlgorithmScalar} from '../../src/semantic/operations.js';
import {hashAlgorithmData} from '../../src/semantic/program.js';

const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
function inputText(value){
  if(Array.isArray(value))return '['+value.map(inputText).join(', ')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).map(([key,item])=>JSON.stringify(key)+': '+inputText(item)).join(', ')+'}';
  return encodeAlgorithmValue(encodeAlgorithmScalar(value));
}
export function comprehensionOutcomeText(outcome){
  if(!['return','throw'].includes(outcome?.kind))throw new TypeError('An independently executed completion is required');
  const graph=outcome.graph,v=value=>encodeAlgorithmValue(value);
  const declarations=graph.objects.map(node=>{
    const properties=new Map(node.properties);
    if(node.kind==='array'){
      const length=properties.get('length')[1],items=[];
      for(let i=0;i<length;i++)items.push(properties.has(String(i))?v(properties.get(String(i))):'<hole>');
      return '@'+node.id+' = ['+items.join(', ')+']';
    }
    return '@'+node.id+' = {'+[...properties].map(([key,value])=>JSON.stringify(key)+': '+v(value)).join(', ')+'}';
  });
  return outcome.kind+' '+v(graph.roots.at(-1))+'; final input roots ['+
    graph.roots.slice(0,-1).map(v).join(', ')+']'+(declarations.length?'; '+declarations.join('; '):'');
}
const taskFixtures=new Map();
const tasks=LANGUAGE_EXPANSION_FAMILIES.flatMap(family=>family.inputs.map((args,index)=>{
  const id=family.id+'-scenario-'+index,outcome=independentBenchmarkOutcome(family.variants[0].source,args),
    expected=comprehensionOutcomeText(outcome),wrong=[];
  for(const nearMiss of family.negatives){
    const result=independentBenchmarkOutcome(nearMiss.source,args);
    if(['return','throw'].includes(result.kind)){
      const text=comprehensionOutcomeText(result);
      if(text!==expected&&!wrong.includes(text))wrong.push(text);
    }
  }
  for(const text of ['throw "unexpected" without a returned value','return undefined without changing any input',
    'suspend with no completed return or throw'])if(text!==expected&&!wrong.includes(text))wrong.push(text);
  const rotation=Number.parseInt(hashAlgorithmData(id).slice(0,8),16)%3;
  const choices=[expected,...wrong.slice(0,2)].map((text,index)=>({id:['a','b','c'][(index+rotation)%3],text}))
    .sort((a,b)=>a.id.localeCompare(b.id));
  taskFixtures.set(id,{id,family:family.family,source:family.variants[0].source,entry:family.entry,
    args:structuredClone(args),fixture:{calls:[]}});
  return {id,family:family.id,category:'counterfactual-outcome',direction:'description-to-operation',
    stimulus:{kind:'description',text:family.meaning+' Domain: '+family.domain+'.'},
    question:'For inputs '+inputText(args)+', which completion and final visible state follow? Object labels preserve aliases; input roots refer to the supplied arguments.',
    choices,answer:['a','b','c'][rotation],rationale:'Execute the declared ordered operation under its domain, preserving completion and rooted input/return aliases.',
    paraphrases:[family.meaning,'Use the stated operation and preserve its order, state changes, and completion distinctions.']};
}));
function conceptual(id,family,category,description,question,choices,answer,rationale){
  return {id,family,category,direction:'description-to-operation',stimulus:{kind:'description',text:description},
    question,choices:choices.map((text,index)=>({id:['a','b','c'][index],text})),answer,
    rationale,paraphrases:[description,rationale]};
}
const protocolTasks=[
  conceptual('getter-invocation-count','getter-effects','callback-execution',
    'Reading account.price invokes a getter that increments reads once and returns 20. The program reads the property once and then multiplies that value by 3.',
    'How often must the getter run?', ['Once; the multiplication uses the committed returned value.','Twice; validation must read the property again.','Zero times; a getter is an ordinary data field.'],'a',
    'Eligibility and validation must not invoke a getter again.'),
  conceptual('cleanup-surviving-throw','cleanup-completion','completion-precedence',
    'A try block prepares return 3. Its finally block throws "cleanup".',
    'Which completion survives?', ['Return 3.','Throw "cleanup".','Return undefined.'],'b',
    'An abrupt finally completion replaces the pending return.'),
  conceptual('resumed-generator-input','generator-input','next-action',
    'A generator executes const x = yield 1; return x + 2. Its first next() yielded 1.',
    'What does next(5) produce?', ['{value:1,done:false}','{value:5,done:false}','{value:7,done:true}'],'c',
    'The resumed input becomes x and the second completion is terminal.'),
  conceptual('postfix-capture-result','capture-identity','mutation-and-alias',
    'Two closures capture the same count cell, currently 2. One returns count++; the other reads count.',
    'What happens after the postfix closure is called once?', ['It returns 2 and the other closure reads 3.','It returns 3 and the other closure reads 3.','It returns 2 and the other closure still reads 2.'],'a',
    'Postfix result and committed cell value differ; the cell remains shared.'),
  conceptual('optional-call-argument','optional-laziness','callback-execution',
    'object is null. The expression is object?.method(expensive()).',
    'Which guest computations run?', ['expensive runs, but method does not.','Neither the arguments nor method run.','Both expensive and method run.'],'b',
    'The nullish base short circuits the entire optional call, including arguments.'),
  conceptual('concurrent-read-correlation','concurrent-requests','next-action',
    'Request r0 reads a. Request r1 reads b. Both are pending. r1 has delivered 20, and the computation needs r0.value + r1.value.',
    'What is the next legal dependent action?', ['Return 40 using r1 twice.','Predict that r0 also delivered 20.','Wait for the environment to deliver r0.'],'c',
    'Request identities remain distinct; the missing external value cannot be generated.'),
  conceptual('module-live-cell-read','module-live-binding','dependency',
    'Module A exports mutable count=1. Module B imports count. A sets count=2 before B reads it.',
    'What does the live import read?', ['2, from the shared export cell.','1, copied at import declaration.','undefined, because imports cannot be mutable.'],'a',
    'A live import aliases the export binding rather than copying its earlier value.'),
  conceptual('setter-write-distinction','setter-effects','claim-checking',
    'Setting object.value calls a setter that stores its argument in object.saved. The setter leaves value as an accessor.',
    'Which compact claim describes the committed field change?', ['write object.value = argument','write object.saved = argument','No state changes can be recorded because a setter ran.'],'b',
    'The set operation invokes behavior; write describes the actual committed data-field mutation.')
];
export const LANGUAGE_EXPANSION_COMPREHENSION_TASKSET=freeze({
  schema:'semantic-comprehension-taskset/1',id:'language-expansion-meaning-v1',version:1,
  profile:'ECMAScript 2026 semantic tasks; each task declares its bounded domain',
  purpose:'Frozen source-free screening across 26 new families plus existing and protocol tasks. External responses are required; source-reference keys are not reader measurements.',
  measurement:'unmeasured',tasks:[...tasks,...structuredClone(SEMANTIC_COMPREHENSION_TASKSET.tasks),...protocolTasks]});
export function expansionTaskFixture(taskId){
  const fixture=taskFixtures.get(taskId);
  return fixture?structuredClone(fixture):null;
}
