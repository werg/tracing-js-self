#!/usr/bin/env node
// Recollect native component fixtures from authored source and input. No old
// trace is translated and no historical admission receipt is relabeled.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {EFFECTFUL_ENGINEERING_FIXTURES} from '../src/training/engineering-fixtures.js';

const output=resolve(process.argv[2]??'artifacts/native-v6-regressions');
await mkdir(output,{recursive:true});
const cycle=()=>{const value={n:1};value.self=value;return value;};
const graph=Object.create(null);graph.n=1;graph.self=graph;
const distinct='"use strict";\nfunction distinct(array, keyFn = value => value) {\n    const seen = new Set();\n    return array.filter(element => {\n        const key = keyFn(element);\n        if (seen.has(key)) {\n            return false;\n        }\n        seen.add(key);\n        return true;\n    });\n}\n';
const compactDistinct='"use strict"; function distinct(array,keyFn=value=>value){const seen=new Set();return array.filter(element=>{const key=keyFn(element);if(seen.has(key)){return false;}seen.add(key);return true;});}';
const short=cycle(),long=cycle();
const tail=EFFECTFUL_ENGINEERING_FIXTURES.find(row=>row.source.includes('for(let i=0;i<40;i++){const ignored=i+1;}'));
if(!tail)throw new Error('Missing authored retained-state fixture');
const cases=[
  {name:'input-array-mutation',source:'"use strict";function run(values){values[0]=values[1];values.pop();return values.length;}',args:[[3,5,7]]},
  {name:'input-mutation-short',source:'"use strict";function run(a,b){a.n=a.n+1;return [a===b,a.self===a,a];}',args:[short,short]},
  {name:'input-mutation-context',source:'"use strict";function run(a,b){for(let i=0;i<12;i++){a.n=a.n+1;}return [a===b,a.self===a,a];}',args:[long,long]},
  {name:'result-mutation-context',source:'"use strict";async function run(){const a=await host.natlangCall("graph",null,[]);for(let i=0;i<12;i++){a.n=a.n+1;}return [a.self===a,a];}',args:[],
    fixture:{calls:[{operation:'natlang.call',arguments:['graph',null,[]],result:graph}]}},
  {name:'source-binding-capture',source:distinct,entry:'distinct',args:[[1,2,1,0,2,5]],license:'MIT'},
  {name:'captured-parameter-name',source:compactDistinct,entry:'distinct',args:[[1,2,1]],license:'MIT'},
  {...tail,name:'retained-state-tail'}
];
for(const input of cases){
  const result=await verifyEffectfulTrainingCase({entry:'run',fixture:{calls:[]},
    ...input,family:'native-v6-regression-'+input.name});
  if(result.status!=='locally_verified')throw new Error(input.name+': '+result.status+': '+result.reason);
  // Public native component tests deliberately omit private admission evidence.
  // Their fixtures therefore carry no full-source/native/learned-success claim.
  const fixture=SelectedExecutionHarness.replay(result.exported).exportEpisode({
    sourceLineage:'controlled:native-v6-regression:'+input.name});
  await writeFile(join(output,input.name+'.json'),JSON.stringify(fixture)+'\n');
  process.stdout.write(JSON.stringify({name:input.name,records:fixture.public.timeline.length,
    independentlyCheckedBeforePrivateEvidenceOmitted:true})+'\n');
}
