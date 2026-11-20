import test from 'node:test';
import assert from 'node:assert/strict';
import {ALGORITHM_VERSION,ALGORITHM_PROFILE,validateAlgorithm,validateTerm,algorithmDigest,
  canonicalAlgorithmString} from '../src/semantic/ir.js';
import {evaluateAlgorithm,evaluateTerm,validateAlgorithmInputs,checkAlgorithmClaim,checkAlgorithmClaims,
  encodeAlgorithmScalar as num} from '../src/semantic/operations.js';
import {normalizeAlgorithm} from '../src/semantic/normalize-algorithm.js';
import {compareObservableGraphs,compareObservables,OBSERVATION_CONTRACT_VERSION} from '../src/semantic/observables.js';
import {createTransformationReceipt,verifyTransformationReceipt,transformationReceiptDigest} from '../src/semantic/provenance.js';
import {evaluateTermV8} from '../src/semantic/algorithm-v8.js';

const lit=value=>({op:'literal',value:num(value)}),input=id=>({op:'input',id}),ref=id=>({op:'ref',id});
const op=(name,...args)=>({op:name,args});
const core=(inputs,steps)=>({schema:ALGORITHM_VERSION,profile:ALGORITHM_PROFILE,inputs,steps});
const computed=(term,inputs=[])=>core(inputs,[{kind:'compute',id:'answer',term},{kind:'return',value:ref('answer')}]);
const sum=()=>computed({op:'fold_left',input:input('numbers'),initial:lit(0),step:'add',order:'ascending',
  profile:'dense-number-array/1'},[{id:'numbers',type:'dense-number-array'}]);
const array=values=>new Map([['array',{kind:'array',properties:new Map([
  ['length',num(values.length)],...values.map((value,index)=>[String(index),num(value)])])}]]);
const outcome=(program,args,environment)=>evaluateAlgorithm(program,args,environment).completion.value;

test('strict IR refuses unknown fields, incorrect operation arity and future dependencies',()=>{
  const valid=computed(op('add',input('x'),lit(1)),[{id:'x',type:'number'}]);
  assert.doesNotThrow(()=>validateAlgorithm(valid));
  for(const mutate of [
    x=>x.extra=true,x=>x.profile='integer-math',x=>x.steps[0].term.args.pop(),
    x=>x.steps[0].term.args[0]=ref('answer'),x=>x.steps[0].id='x',
    x=>x.steps.push({kind:'return',value:lit(1)}),x=>x.steps[0].term.op='arbitrary_js',
    x=>x.steps[0].term.site={start:1,end:2}
  ]){const invalid=structuredClone(valid);mutate(invalid);assert.throws(()=>validateAlgorithm(invalid));}
  assert.throws(()=>validateTerm({op:'literal',value:['num',-0]}),/noncanonical/);
  assert.throws(()=>validateTerm({op:'literal',value:['num',Infinity]}),/noncanonical/);
});

test('malformed algorithm records and scalar tags never invoke getters or proxy traps',()=>{
  let hooks=0;
  const term={args:[lit(1),lit(2)]};
  Object.defineProperty(term,'op',{enumerable:true,get(){hooks++;return 'add';}});
  assert.throws(()=>validateTerm(term));
  const tagged=['num',1];Object.defineProperty(tagged,'1',{enumerable:true,get(){hooks++;return 1;}});
  assert.throws(()=>evaluateTerm({op:'literal',value:tagged}));
  const proxy=new Proxy({op:'literal',value:num(1)},{getPrototypeOf(){hooks++;return Object.prototype;},
    ownKeys(){hooks++;return ['op','value'];},get(){hooks++;return 'literal';}});
  assert.throws(()=>validateTerm(proxy));
  const inherited=Object.create({op:'literal',value:num(1)});assert.throws(()=>validateTerm(inherited));
  const iteration=[lit(1),lit(2)];iteration[Symbol.iterator]=()=>{hooks++;throw Error('must not iterate');};
  assert.throws(()=>validateTerm({op:'add',args:iteration}));
  assert.equal(hooks,0,'refusing malformed data must itself be effect-free');
});

test('normalization is capture-free, deterministic, idempotent and retains an explicit computation',()=>{
  const original=core([{id:'left',type:'number'},{id:'right',type:'number'}],[
    {kind:'compute',id:'first',term:op('add',input('left'),input('right'))},
    {kind:'compute',id:'copy',term:ref('first')},
    {kind:'compute',id:'result',term:op('multiply',ref('copy'),lit(2))},
    {kind:'return',value:ref('result')}
  ]);
  const normalized=normalizeAlgorithm(original);
  assert.deepEqual(normalizeAlgorithm(normalized),normalized);
  assert.deepEqual(normalizeAlgorithm(original),normalized);
  assert.deepEqual(normalized.steps.map(step=>step.kind),['compute','return']);
  assert.deepEqual(normalized.steps[0].term,op('multiply',op('add',input('a0'),input('a1')),lit(2)));
  const other=computed(op('multiply',op('add',input('x'),input('y')),lit(2)),
    [{id:'x',type:'number'},{id:'y',type:'number'}]);
  assert.equal(canonicalAlgorithmString(normalized),canonicalAlgorithmString(normalizeAlgorithm(other)));
  assert.equal(algorithmDigest(normalized),algorithmDigest(normalizeAlgorithm(other)));
  assert.deepEqual(outcome(normalized,[num(1),num(2)]),num(6));
});

test('normalization does not merge value coincidences or remove potentially throwing dead work',()=>{
  const a=normalizeAlgorithm(computed(op('add',input('x'),lit(1)),[{id:'x',type:'number'}]));
  const b=normalizeAlgorithm(computed(op('multiply',input('x'),lit(2)),[{id:'x',type:'number'}]));
  assert.deepEqual(outcome(a,[num(1)]),outcome(b,[num(1)]));
  assert.notEqual(algorithmDigest(a),algorithmDigest(b));
  const risky=core([{id:'x',type:'scalar'}],[{kind:'compute',id:'unused',term:op('divide',input('x'),lit(0n))},
    {kind:'return',value:lit(7)}]);
  assert.equal(normalizeAlgorithm(risky).steps.length,2);
  assert.throws(()=>evaluateAlgorithm(risky,[num(1n)]),RangeError);
  const harmless=core([{id:'x',type:'number'}],[{kind:'compute',id:'unused',term:op('divide',input('x'),lit(0))},
    {kind:'return',value:lit(7)}]);
  assert.equal(normalizeAlgorithm(harmless).steps.length,1);
});

test('primitive meanings preserve number/string addition, bigint failures, NaN and signed zero',()=>{
  assert.deepEqual(evaluateTerm(op('add',lit('2'),lit(3))),['str','23']);
  assert.deepEqual(evaluateTerm(op('add',lit(2),lit(3))),num(5));
  assert.deepEqual(evaluateTerm(op('multiply',lit(-0),lit(2))),['num','-0']);
  assert.deepEqual(evaluateTerm(op('equal',lit(NaN),lit(NaN))),['bool',false]);
  assert.deepEqual(evaluateTerm(op('divide',lit(1),lit(0))),['num','+Infinity']);
  assert.throws(()=>evaluateTerm(op('add',lit(1n),lit(1))),TypeError);
  assert.throws(()=>evaluateTerm(op('divide',lit(1n),lit(0n))),RangeError);
});

test('legacy fold charges every numeric item to the semantic work budget',()=>{
  const term={op:'fold_left',input:{op:'array',items:[lit(1),lit(2),lit(3)]},initial:lit(0),step:'add',
    order:'ascending',profile:'dense-number-array/1'};
  assert.throws(()=>evaluateTermV8(term,{budget:{remaining:8}}),/semantic work budget/);
  assert.deepEqual(evaluateTermV8(term,{budget:{remaining:9}}),num(6));
});

test('selections and logical terms preserve lazy evaluation and primitive truth',()=>{
  const throws=op('divide',lit(1n),lit(0n));
  assert.deepEqual(evaluateTerm(op('select',lit(false),throws,lit(4))),num(4));
  assert.deepEqual(evaluateTerm(op('and',lit(0),throws)),num(0));
  assert.deepEqual(evaluateTerm(op('or',lit('present'),throws)),['str','present']);
  assert.deepEqual(evaluateTerm(op('coalesce',lit(0),throws)),num(0));
  assert.deepEqual(evaluateTerm(op('coalesce',lit(undefined),lit(9))),num(9));
});

test('ordered binary64 accumulation retains empty/singleton/signed-zero and rounding-sensitive behavior',()=>{
  for(const [values,expected] of [[[],0],[[-0],0],[[8],8],[[1e16,1,-1e16],0],
    [[1e16,-1e16,1],1],[[Number.MAX_VALUE,Number.MAX_VALUE],Infinity]])
    assert.deepEqual(outcome(sum(),[['ref','array']],{heap:array(values)}),num(expected));
  const reversed=sum();reversed.steps[0].term.order='descending';
  assert.throws(()=>validateAlgorithm(reversed),/fold profile/);
  assert.throws(()=>validateAlgorithmInputs(sum(),[['ref','array']],{heap:array([Infinity])}),/finite/);
  assert.throws(()=>validateAlgorithmInputs(sum(),[['ref','array']],{heap:array(['2'])}),/finite/);
});

test('ordered fold refuses holes, extra properties, hooks, nonordinary prototypes and overlong arrays',()=>{
  for(const mutate of [
    heap=>heap.get('array').properties.delete('0'),
    heap=>heap.get('array').properties.set('reduce',['undefined']),
    heap=>heap.get('array').properties.set(Symbol.iterator,['undefined']),
    heap=>heap.get('array').accessors={0:{get:'hook'}},
    heap=>heap.get('array').prototype='custom',
    heap=>heap.get('array').iterator='custom'
  ]){const heap=array([2,3]);mutate(heap);assert.throws(()=>outcome(sum(),[['ref','array']],{heap}));}
  assert.throws(()=>outcome(sum(),[['ref','array']],{heap:array(Array(129).fill(1))}),/bound/);
});

test('heap inspection rejects accessors and duplicate properties and bypasses Map subclass hooks',()=>{
  let hooks=0;
  const node={kind:'array'};Object.defineProperty(node,'properties',{enumerable:true,
    get(){hooks++;return new Map([['length',num(0)]]);}});
  assert.throws(()=>evaluateAlgorithm(sum(),[['ref','array']],{heap:new Map([['array',node]])}));
  const properties={length:num(1)};Object.defineProperty(properties,'0',{enumerable:true,
    get(){hooks++;return {value:num(2)};}});
  assert.throws(()=>evaluateAlgorithm(sum(),[['ref','array']],{heap:new Map([['array',{kind:'array',properties}]])}));
  const duplicated=new Map([['array',{kind:'array',properties:[['length',num(1)],['0',num(1)],['0',num(2)]]}]]);
  assert.throws(()=>evaluateAlgorithm(sum(),[['ref','array']],{heap:duplicated}),/Duplicate/);
  class HookedMap extends Map {
    get(){hooks++;throw Error('must use the intrinsic Map operation');}
    entries(){hooks++;throw Error('must use the intrinsic Map operation');}
    [Symbol.iterator](){hooks++;throw Error('must use the intrinsic Map operation');}
  }
  const hooked=new HookedMap([['array',{kind:'array',properties:new HookedMap([['length',num(1)],['0',num(9)]])}]]);
  assert.deepEqual(outcome(sum(),[['ref','array']],{heap:hooked}),num(9));
  assert.equal(hooks,0);
});

test('semantic values cannot invent a reference outside the committed heap',()=>{
  assert.throws(()=>evaluateTerm({op:'literal',value:['ref','missing']}),/ordinary data object/);
  assert.throws(()=>evaluateTerm(ref('selected'),{values:new Map([['selected',['ref','missing']]])}),/ordinary data object/);
  const heap=new Map([['box',{kind:'object',properties:new Map([['child',['ref','missing']]])}]]);
  const program=computed({op:'project',object:input('object'),key:'child'},[{id:'object',type:'data'}]);
  assert.throws(()=>evaluateAlgorithm(program,[['ref','box']],{heap}),/Dangling/);
  assert.throws(()=>evaluateTerm(program.steps[0].term,{inputs:new Map([['object',['ref','box']]]),heap}),/ordinary data object/);
});

test('normalization retains reads across writes, eager throws, and order-sensitive algebra',()=>{
  const program=core([{id:'object',type:'data'}],[
    {kind:'compute',id:'previous',term:{op:'project',object:input('object'),key:'n'}},
    {kind:'write',object:input('object'),key:'n',value:lit(9),present:true},
    {kind:'return',value:ref('previous')}
  ]);
  const normalized=normalizeAlgorithm(program);
  assert.deepEqual(normalized.steps.map(step=>step.kind),['compute','write','return']);
  assert.deepEqual(outcome(normalized,[['ref','box']],{heap:new Map([['box',{kind:'object',
    properties:new Map([['n',num(2)]])}]])}),num(2));
  const eager=core([{id:'x',type:'scalar'}],[{kind:'compute',id:'risk',term:op('divide',input('x'),lit(0n))},
    {kind:'compute',id:'chosen',term:op('select',lit(false),ref('risk'),lit(7))},
    {kind:'return',value:ref('chosen')}]);
  assert.throws(()=>evaluateAlgorithm(normalizeAlgorithm(eager),[num(1n)]),RangeError);
  const inputX=[{id:'x',type:'number'}];
  for(const term of [op('add',input('x'),lit(0)),op('multiply',input('x'),lit(0))])
    assert.notEqual(algorithmDigest(normalizeAlgorithm(computed(term,inputX))),
      algorithmDigest(normalizeAlgorithm(computed(input('x'),inputX))));
  assert.deepEqual(outcome(normalizeAlgorithm(computed(op('add',input('x'),lit(0)),inputX)),[num(-0)]),num(0));
  assert.deepEqual(outcome(normalizeAlgorithm(computed(op('multiply',input('x'),lit(0)),inputX)),[num(Infinity)]),num(NaN));
});

test('false emitted intermediate claims fail even when the final result is correct',()=>{
  const program=core([{id:'x',type:'number'}],[
    {kind:'compute',id:'intermediate',term:op('add',input('x'),lit(1))},
    {kind:'compute',id:'answer',term:op('multiply',ref('intermediate'),lit(0))},
    {kind:'return',value:ref('answer')}
  ]);
  const {claims}=evaluateAlgorithm(program,[num(2)]);
  assert(checkAlgorithmClaims(program,[num(2)],claims).consistent);
  assert(checkAlgorithmClaims(program,[num(2)],[claims.at(-1)]).consistent,'omitted claims are not false claims');
  claims[0].result=num(999);
  assert.equal(checkAlgorithmClaims(program,[num(2)],claims).consistent,false);
  assert.equal(checkAlgorithmClaim(op('add',lit(2),lit(1)),num(999)).consistent,false);
});

const counter=()=>core([], [
  {kind:'request',id:'read',boundary:'siteRead',operation:'storage.read',arguments:[lit('counter')]},
  {kind:'observe',id:'current',request:'read'},
  {kind:'compute',id:'next',term:op('add',ref('current'),lit(1))},
  {kind:'request',id:'store',boundary:'siteStore',operation:'storage.write',arguments:[lit('counter'),ref('next')]},
  {kind:'observe',id:'stored',request:'store'},
  {kind:'return',value:ref('next')}
]);
test('effect evaluation stops at unseen observations and respects dispatch/delivery order',()=>{
  const program=counter(),pending=evaluateAlgorithm(program,[]);
  assert.equal(pending.completion.kind,'suspend');assert.equal(pending.requests.length,1);
  const partial=evaluateAlgorithm(program,[],{observations:[{request:'read',status:'fulfilled',result:num(7)}]});
  assert.deepEqual(partial.requests.map(row=>row.arguments),[[['str','counter']],[['str','counter'],num(8)]]);
  assert.equal(partial.completion.kind,'suspend');
  const complete=evaluateAlgorithm(program,[],{observations:[{request:'read',status:'fulfilled',result:num(7)},
    {request:'store',status:'completed'}]});
  assert.deepEqual(complete.completion,{kind:'return',value:num(8)});
  const changed=evaluateAlgorithm(program,[],{observations:[{request:'read',status:'fulfilled',result:num(70)}]});
  assert.deepEqual(pending.requests[0],changed.requests[0]);
  assert.throws(()=>evaluateAlgorithm(program,[],{observations:[{request:'store',status:'completed'}]}),/delivery order/);
  assert.throws(()=>evaluateAlgorithm(program,[],{observations:[{request:'read',status:'fulfilled',result:num(7),mode:'generated'}]}),/authority/);
  assert.throws(()=>evaluateAlgorithm(program,[],{observations:[{request:'read',status:'completed',result:['undefined']}]}),/authority/);
  const rejected=evaluateAlgorithm(program,[],{observations:[{request:'read',status:'rejected',result:['str','failed']}]});
  assert.deepEqual(rejected.completion,{kind:'throw',value:['str','failed']});assert.equal(rejected.requests.length,1);
});

test('normalization keeps effect boundaries and never propagates an observed value into an earlier prefix',()=>{
  const normalized=normalizeAlgorithm(counter());
  assert.deepEqual(normalized.steps.map(step=>step.kind),['request','observe','compute','request','observe','return']);
  assert.deepEqual(normalized.steps.filter(step=>step.kind==='request').map(step=>step.boundary),['b0','b1']);
  assert.deepEqual(normalizeAlgorithm(normalized),normalized);
});

const object=(id,properties)=>({id,kind:'object',properties});
test('observable graph comparison preserves cycles and aliases while ignoring private allocation labels',()=>{
  const left={roots:[['ref','input'],['ref','input']],objects:[object('input',[
    ['self',['ref','input']],['value',num(3)]
  ]),object('private',[['ignored',num(999)]])]};
  const right={roots:[['ref','renamed'],['ref','renamed']],objects:[object('renamed',[
    ['self',['ref','renamed']],['value',num(3)]
  ])]};
  assert(compareObservableGraphs(left,right,{leftInputIds:['input'],rightInputIds:['renamed']}).equal);
  const copy=structuredClone(right);copy.objects.push(object('fresh',[
    ['self',['ref','fresh']],['value',num(3)]
  ]));copy.roots[1]=['ref','fresh'];
  assert.equal(compareObservableGraphs(left,copy,{leftInputIds:['input'],rightInputIds:['renamed']}).equal,false);
});

test('observable graphs distinguish absent from undefined, signed zero and input mutations',()=>{
  const original={roots:[['ref','a']],objects:[object('a',[['x',['undefined']]])]};
  for(const properties of [[],[['x',num(0)]],[['x',num(-0)]]])
    assert.equal(compareObservableGraphs(original,{roots:[['ref','b']],objects:[object('b',properties)]}).equal,false);
  const zero={roots:[num(0)],objects:[]},negative={roots:[num(-0)],objects:[]};
  assert.equal(compareObservableGraphs(zero,negative).equal,false);
  const left={roots:[num(1)],objects:[object('a',[['state',num(1)]])]},
    right={roots:[num(1)],objects:[object('b',[['state',num(2)]])]};
  assert.equal(compareObservableGraphs(left,right,{leftInputIds:['a'],rightInputIds:['b']}).equal,false);
});

test('observation contract checks effect multiplicity/order, correlated delivery and completion category',()=>{
  const record={schema:OBSERVATION_CONTRACT_VERSION,completion:{kind:'return',value:num(3)},
    graph:{roots:[num(3)],objects:[]},effects:[{id:'write1',operation:'store',arguments:[num(3)]}],
    observations:[{effect:'write1',status:'completed'}],continuation:null};
  const renamed=structuredClone(record);renamed.effects[0].id='external_92';renamed.observations[0].effect='external_92';
  assert(compareObservables(record,renamed).equal);
  const duplicate=structuredClone(record);duplicate.effects.push({id:'write2',operation:'store',arguments:[num(3)]});
  assert.equal(compareObservables(record,duplicate).equal,false);
  const failed=structuredClone(record);failed.completion={kind:'internal-failure',reason:'runtime failure'};
  assert.equal(compareObservables(record,failed).equal,false);
  const undefinedValue=structuredClone(record);undefinedValue.observations[0]={effect:'write1',status:'fulfilled',result:['undefined']};
  assert.equal(compareObservables(record,undefinedValue).equal,false);
});

test('private transformation receipts bind exact source, rule/domain/interface and both semantic fragments',()=>{
  const program=computed(op('add',input('x'),lit(1)),[{id:'x',type:'number'}]);
  const expected={rule:'private-temporary',source:'function run(x){const y=x+1;return y;}',input:program,
    output:normalizeAlgorithm(program),sourceSites:[{start:0,end:48}],journalEvents:['e1','e2'],
    preconditions:['binary64 number arguments','no observable hooks'],liveInputs:['x'],liveOutputs:['answer'],effectBoundaries:[]};
  const receipt=createTransformationReceipt(expected);
  assert(verifyTransformationReceipt(receipt,expected));
  assert.match(transformationReceiptDigest(receipt),/^[0-9a-f]{64}$/);
  for(const mutate of [x=>x.rule='different',x=>x.sourceDigest='0'.repeat(64),x=>x.preconditions.pop(),
    x=>x.liveInputs.push('future'),x=>x.journalEvents.reverse(),x=>x.outputDigest='1'.repeat(64)]){
    const tampered=structuredClone(receipt);mutate(tampered);assert.equal(verifyTransformationReceipt(tampered,expected),false);
  }
});
