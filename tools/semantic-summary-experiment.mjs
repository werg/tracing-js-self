// A diagnostic summary endpoint, not a model or production v5 adapter.
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {encodeNativeGraph} from '../src/host/graph-codec.js';
import {createSemanticSummaryContext,buildSemanticSummaryExperiment} from '../src/training/semantic-summary-experiment.js';

const options={};
for(let index=2;index<process.argv.length;index++){
  const argument=process.argv[index];
  if(argument==='--demo'){options.demo=true;continue;}
  if(!['--out','--context','--summary','--family'].includes(argument))throw Error('Unknown option '+argument);
  const value=process.argv[++index];if(!value||value.startsWith('--'))throw Error('Missing value for '+argument);
  options[argument.slice(2)]=value;
}
if(!options.out)throw Error('Usage: --demo --out <directory>, or --context <json> --summary <json> --family <lineage> --out <directory>');
if(options.demo&&['context','summary','family'].some(key=>options[key]))throw Error('Demo and supplied prediction options cannot be mixed');
const out=resolve(options.out),candidates=[];
if(options.demo){
  const helper=createSemanticSummaryContext({profile:'pure-helper/1',
    source:'"use strict";function increment(value){return value+1;}',entry:'increment',inputGraph:encodeNativeGraph([4])});
  const sum=createSemanticSummaryContext({profile:'dense-array-sum/1',
    source:'"use strict";function sum(xs){let total=0;for(let i=0;i<xs.length;i++){total+=xs[i];}return total;}',
    entry:'sum',inputGraph:encodeNativeGraph([[2,3,4]])});
  const control=createSemanticSummaryContext({profile:'pure-control-helper/1',
    source:'"use strict";function select(x,flag,fallback){return x<0?(flag&&(-x)):(fallback??3);}',
    entry:'select',inputGraph:encodeNativeGraph([-4,true,0])});
  const returned=value=>({schema:'experimental-semantic-summary/1',completion:{kind:'return',value:['num',value]},inputUnchanged:true});
  const summed=checkpoints=>({...returned(9),iterations:3,
    stateDelta:{binding:'total',before:['num',0],after:['num',9]},checkpoints});
  const controlSummary={...returned(4),decisions:[
    {site:control.decisionSites[0].site,selected:'consequent'},
    {site:control.decisionSites[1].site,selected:'right'}]};
  candidates.push({id:'pure-helper',context:helper,summary:returned(5),family:'summary-prototype-pure-helper',expected:'experimental_verified'},
    {id:'dense-sum-coarse',context:sum,summary:summed([]),family:'summary-prototype-dense-sum',expected:'experimental_verified'},
    {id:'dense-sum-checkpoints',context:sum,summary:summed([
      {iteration:1,total:['num',2]},{iteration:2,total:['num',5]},{iteration:3,total:['num',9]}]),
      family:'summary-prototype-dense-sum',expected:'experimental_verified'},
    {id:'false-intermediate',context:sum,summary:summed([{iteration:1,total:['num',99]}]),
      family:'summary-prototype-dense-sum',expected:'rejected'},
    {id:'pure-control-helper',context:control,summary:controlSummary,
      family:'summary-prototype-pure-control',expected:'experimental_verified'},
    {id:'false-control-with-correct-result',context:control,
      summary:{...controlSummary,decisions:[{site:control.decisionSites[0].site,selected:'alternate'}]},
      family:'summary-prototype-pure-control',expected:'rejected'});
}else{
  if(!options.context||!options.summary||!options.family)throw Error('Context, summary and lineage are all required');
  candidates.push({id:'supplied',context:JSON.parse(await readFile(resolve(options.context),'utf8')),
    summary:JSON.parse(await readFile(resolve(options.summary),'utf8')),family:options.family,expected:'experimental_verified'});
}
await mkdir(out,{recursive:true});
const rows=[];
for(const candidate of candidates){
  const result=await buildSemanticSummaryExperiment(candidate);
  const filename=candidate.id+'.json';
  await writeFile(join(out,filename),JSON.stringify({predictionOrigin:options.demo?'authored-diagnostic':'supplied-by-caller',
    candidate,result},null,2)+'\n');
  rows.push({id:candidate.id,status:result.status,expected:candidate.expected,
    ...(result.metrics?{metrics:result.metrics}:{reason:result.reason}),evidence:filename});
  if(result.status!==candidate.expected)process.exitCode=1;
}
const report={schema:'semantic-summary-prototype-report/1',predictionOrigin:options.demo?'authored-diagnostic':'supplied-by-caller',
  nativeAdmission:false,learningStatus:'untested',rows};
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');
const markdown=['# Bounded semantic summary prototype','',
  'These predictions are '+report.predictionOrigin+'. The report measures independent checking and target bytes, not model learning or native qualification.','',
  '| Case | Verdict | Detailed records | Detailed bytes | Summary bytes |',
  '| --- | --- | ---: | ---: | ---: |',
  ...rows.map(row=>'| '+[row.id,row.status,row.metrics?.detailedRecords??'—',row.metrics?.detailedBytes??'—',row.metrics?.summaryBytes??'—'].join(' | ')+' |'),'',
  'Each evidence JSON retains the original prediction and context; accepted cases retain the detailed v5 execution archive and independent V8 original/operation/branch receipts. Rejected predictions are preserved without a corrected answer.','',
  'The summary context is supplied as a separate region task. Target bytes exclude its source, input graph, region metadata and other observed context; detailed target bytes likewise exclude their observed context. Native tokens, full-context costs and learned performance are unmeasured.',''];
await writeFile(join(out,'README.md'),markdown.join('\n'));
console.log(JSON.stringify(report));
