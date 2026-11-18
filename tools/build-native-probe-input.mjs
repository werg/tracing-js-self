#!/usr/bin/env node
// Source-certify one current candidate and cut its public prefix immediately
// before the first generated semantic record. No teacher expectation enters it.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {recheckEffectfulAdmission} from '../src/training/effectful-admit.js';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';

const filename=process.argv[2];
if(!filename||process.argv.length!==3)throw new TypeError('Usage: build-native-probe-input.mjs EPISODE.json');
const raw=readFileSync(filename),exported=JSON.parse(raw);
const sourceAdmission=await recheckEffectfulAdmission(exported,
  {requireAdmitted:exported.sidecar.admission==='admitted'});
const index=exported.public.timeline.findIndex(row=>row.kind==='semantic');
if(index<2)throw new TypeError('A complete initial public prefix is required');
const item=exported.public.timeline[index];
const harness=SelectedExecutionHarness.replay({public:{...exported.public,
  timeline:exported.public.timeline.slice(0,index)}},{requireTerminal:false});
const invocation=harness.invocations.get(item.invocationId);
if(invocation.activation!=='call'||harness.invocations.size!==1)
  throw new TypeError('Initial input-parity probe requires the first direct call in a new runtime');
const driver=new SelectedModelDriver({harness,select:()=>{throw new Error('No model is selected by a prefix probe');}});
try{
  const prefix=driver.prefix(item.invocationId);
  const allowed=['schema','representation','admission','selectionOrigin','referenceStatus','sourceLineage',
    'ancestorIds','taskId','split','identityDigest'];
  const packet={schema:'semantic-native-input-probe/1',episodeSha256:createHash('sha256').update(raw).digest('hex'),
    sourceAdmission,publicJson:JSON.stringify(exported.public),
    exported:{public:exported.public,sidecar:Object.fromEntries(allowed.map(key=>[key,exported.sidecar[key]]))},
    prefix,firstTarget:{sequence:item.sequence,record:item.line}};
  if(!raw.equals(readFileSync(filename)))throw new Error('Candidate changed during source verification');
  process.stdout.write(JSON.stringify(packet)+'\n');
}finally{driver.close();}
