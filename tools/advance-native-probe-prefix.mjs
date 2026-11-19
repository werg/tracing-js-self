#!/usr/bin/env node
// Advance a diagnostic prefix only with the actual service's returned bytes.
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {SelectedModelDriver} from '../src/training/model-driver.js';
const chunks=[];
for await(const chunk of process.stdin)chunks.push(chunk);
const {publicHeader,prefix,selection}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!publicHeader||Object.hasOwn(publicHeader,'timeline')||
   selection?.schema!=='selected-model-output/2'||
   selection.selection?.origin!=='actual-model-selected'||
   selection.selection?.modelSelected!==true||typeof selection.record!=='string'||
   prefix?.schema!=='selected-inference-prefix/2')
  throw new TypeError('An actual returned selection and prior public prefix are required');
if(prefix.realmCommitted.some(row=>row.kind==='semantic'))
  throw new TypeError('This bounded diagnostic advances only its first selected record');
const harness=SelectedExecutionHarness.replay({public:{...publicHeader,timeline:prefix.realmCommitted}},
  {requireTerminal:false});
const driver=new SelectedModelDriver({harness,select:()=>{throw new Error('No model is called by prefix reconstruction');}});
try{
  if(JSON.stringify(driver.prefix(prefix.invocationId))!==JSON.stringify(prefix))
    throw new Error('Actual initial prefix differs from public replay');
  if(selection.selection.sourceReads?.length)
    harness.recordModelContext(prefix.invocationId,selection.selection.sourceReads);
  harness.selected(prefix.invocationId,selection.record);
  const next=driver.prefix(prefix.invocationId);
  const committed=next.committed.filter(row=>row.kind==='semantic');
  if(committed.length!==1||committed[0].line!==selection.record)
    throw new Error('Public commitment changed the model-selected bytes');
  process.stdout.write(JSON.stringify({prefix:next,committedRecord:committed[0],
    semanticValidation:'passed',teacherSubstitution:false})+'\n');
}finally{driver.close();}
