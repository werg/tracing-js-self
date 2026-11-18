// Reviewed bounded grammar, never arbitrary generated JavaScript. Inputs and
// generation use separate deterministic seeds; execution supplies every label.
import {parse} from 'acorn';
import {canonicalHash} from './source-registry.mjs';

const maps={identity:'x',absolute:'x<0?-x:x',square:'x*x',offset:'x+amount'};
const predicates={all:'true',positive:'current>0',even:'current%2===0'};
const reducers={sum:'total=total+current;',product:'total=total*current;',
  maximum:'if(seen===0||current>total){total=current;}'};
function random(seed){let state=seed>>>0;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};}
const choices=[];
for(const map of Object.keys(maps))for(const predicate of Object.keys(predicates))
  for(const reducer of Object.keys(reducers))for(const alias of [false,true])for(const exception of [false,true])
    choices.push({map,predicate,reducer,alias,exception});
export const GENERATED_GRAMMAR_FAMILIES=choices.length;

function sourceFor(choice,offset){
  const mapper='function transform(x,amount='+offset+'){return '+maps[choice.map]+';}';
  const initial=choice.reducer==='product'?'1':'0';
  const finish=choice.alias?'alias[0]=total;return [total,values,alias];':'return total;';
  const source='"use strict";'+mapper+'function run(values,limit){let total='+initial+';let seen=0;'+
    (choice.alias?'const alias=values;':'')+
    'for(let i=0;i<values.length;i++){const current=transform(values[i]);if('+predicates[choice.predicate]+'){'+
    reducers[choice.reducer]+'seen=seen+1;}}'+(choice.exception?'if(seen>limit){throw 7;}':'')+finish+'}';
  const ast=parse(source,{ecmaVersion:2022});let nodes=0;
  function visit(value){if(Array.isArray(value)){value.forEach(visit);return;}
    if(!value||typeof value!=='object')return;if(value.type)nodes++;
    for(const [key,item] of Object.entries(value))if(!['start','end'].includes(key))visit(item);}
  visit(ast);
  if(nodes>160||source.length>1200)throw new Error('Bounded grammar exceeded its declared AST/source budget');
  return {source,astNodes:nodes};
}
export function generatedProgramCases({families=16,perFamily=4,generationSeed=73,inputSeed=89}={}){
  if(!Number.isSafeInteger(families)||families<1||families>GENERATED_GRAMMAR_FAMILIES||
    !Number.isSafeInteger(perFamily)||perFamily<1||perFamily>24||
    !Number.isSafeInteger(generationSeed)||generationSeed<0||generationSeed>0xffffffff||
    !Number.isSafeInteger(inputSeed)||inputSeed<0||inputSeed>0xffffffff)
    throw new TypeError('Invalid bounded generated-program options');
  const rng=random(generationSeed),selection=choices.map(choice=>({...choice}));
  for(let index=selection.length-1;index>0;index--){const other=rng()%(index+1);
    [selection[index],selection[other]]=[selection[other],selection[index]];}
  const rows=[];
  for(const choice of selection.slice(0,families)){
    const shape=canonicalHash(choice),family='generated-grammar:'+shape.slice(0,24),offset=1+rng()%4;
    const {source,astNodes}=sourceFor(choice,offset);
    const composition=[choice.map,choice.predicate,choice.reducer,choice.alias?'alias':'scalar',choice.exception?'throw':'return'].join('/');
    const inputRng=random((inputSeed^parseInt(shape.slice(0,8),16))>>>0);
    for(let index=0;index<perFamily;index++){
      const values=index===0?[]:index===1?[0]:index===2?[-3,0,3]:
        Array.from({length:2+inputRng()%6},()=>Number(inputRng()%19)-9);
      const limit=index%2===0?1:0;
      rows.push({id:'generated-'+shape.slice(0,20)+'-'+index,family,entry:'run',source,
        args:[values,limit],fixture:{calls:[]},license:'repository-fixture',trustTier:'repository-fixture',
        maxSteps:20000,timeoutMs:10000,projectionOptions:{maxGenerated:4096},
        seeds:{generation:generationSeed,input:inputSeed,schedule:0},
        provenance:{schema:'bounded-program-grammar/1',grammarRevision:1,shape,choice,composition,
          astNodes,sourceBytes:Buffer.byteLength(source),maxInputLength:7,
          sourceFamilyPolicy:'structural-grammar-choice; literal/input variants retain the same family',
          inputIndex:index,inputOrigin:index<3?'audited-empty-zero-signed-boundary':'seeded-bounded-integers',
          expectedOutcome:null,labels:'independent-execution-only',upstream:null}});
    }
  }
  return rows;
}
