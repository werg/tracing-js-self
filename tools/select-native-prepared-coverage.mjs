#!/usr/bin/env node
// Derive a new existing-format sampler; native materialization remains a
// separate authenticated pass through materialize-native-prepared-subset.py.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {selectPreparedCoverage,historicalCoverageAvailability,consumedTargetInventory} from '../src/corpus/native-prepared-coverage.mjs';

const {values}=parseArgs({options:{sampler:{type:'string'},'source-manifest':{type:'string'},out:{type:'string'},
  'max-family-tokens':{type:'string'},'max-family-share':{type:'string'},'max-training-tokens':{type:'string'},
  'optimization-report':{type:'string'},'native-schedule':{type:'string'}}});
if(!values.sampler||!values.out)throw new Error('Usage: select-native-prepared-coverage.mjs --sampler FILE --out NEW_DIR [--source-manifest FILE] [--max-family-tokens N --max-family-share F --max-training-tokens N] [--optimization-report FILE --native-schedule FILE]');
const load=path=>{const bytes=readFileSync(resolve(path));return {value:JSON.parse(bytes),sha256:createHash('sha256').update(bytes).digest('hex')};};
const output=resolve(values.out);if(existsSync(output))throw new Error('Use a new output directory; historical evidence is immutable');
const input=load(values.sampler),original=input.value;
let result;
if(original.schema==='semantic-native-prepared-training-sampler-receipt/1'){
  if(values['source-manifest']||values['optimization-report']||values['native-schedule']||
    Object.keys(values).some(key=>key.startsWith('max-')))
    throw new Error('Reduced receipt can report availability only; obtain complete acceptedDecisions before selection');
  result={coverage:historicalCoverageAvailability(original)};
}else{
  if(!values['source-manifest'])throw new Error('Complete selection requires the original source manifest');
  const source=load(values['source-manifest']);
  if(source.sha256!==original.sourceManifestSha256)throw new Error('Original source manifest bytes changed');
  const policy={...original.policy};
  for(const [option,key] of [['max-family-tokens','maxFamilyTokens'],['max-family-share','maxFamilyShare'],['max-training-tokens','maxTrainingTokens']])
    if(values[option]!==undefined)policy[key]=Number(values[option]);
  result=selectPreparedCoverage(original,source.value,{policy});
  result.coverage.sourceManifestSha256=source.sha256;
  if(Boolean(values['optimization-report'])!==Boolean(values['native-schedule']))
    throw new Error('Actual consumed-target accounting needs both optimizer report and native schedule');
  if(values['optimization-report']){
    const report=load(values['optimization-report']),schedule=load(values['native-schedule']);
    if(report.value.nativeSchedulePlanSha256!==schedule.sha256)throw new Error('Native schedule bytes differ from optimizer receipt');
    result.coverage.inventories.consumed=consumedTargetInventory(original,report.value,schedule.value);
    result.coverage.inventories.consumed.reportSha256=report.sha256;
    result.coverage.inventories.consumed.nativeScheduleSha256=schedule.sha256;
  }
}
result.coverage.parentSamplerSha256=input.sha256;
mkdirSync(output);
writeFileSync(join(output,'coverage.json'),JSON.stringify(result.coverage,null,2)+'\n',{flag:'wx'});
if(result.sampler)writeFileSync(join(output,'sampler.json'),JSON.stringify(result.sampler,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:result.coverage.status,selectionCreated:Boolean(result.sampler),
  coverage:join(output,'coverage.json'),sampler:result.sampler?join(output,'sampler.json'):null}));
