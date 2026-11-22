// Controlled lexical fixture, not learned behavior: two exact declared root
// calls use the existing source/input and independently replayed semantic rows.
import assert from 'node:assert/strict';
import {stableAlgorithmJSON} from '../../src/semantic/ir.js';

export function laterSiblingBootstrapFixture(document){
  const copy=structuredClone,rows=copy(document.public.timeline.slice(0,2)),
    decisions=document.sidecar.orchestrationTranscript.events.filter(event=>event.kind==='decision').map(event=>event.record),
    targets=document.public.timeline.filter(row=>row.mode==='generated').map(row=>row.fields.line);
  assert.equal(decisions.length,4);assert.equal(targets.length,2);
  assert.equal(rows[0].kind,'program');assert.equal(rows[1].kind,'invocation');
  rows[1].fields.realmPolicy='fresh';
  const second=copy(rows[1]);second.sequence=3;
  Object.assign(second.fields,{track:'worker2',invocationId:'invocation2',realmId:'realm2',
    triggerId:'teacher-entry-2',ingressKey:'teacher-entry-2'});
  rows.push(second);
  const firstCreate=JSON.parse(decisions[0]);firstCreate.arguments.execution.realm_policy='fresh';
  const create=copy(firstCreate),join=JSON.parse(decisions[1]);
  Object.assign(create.arguments.execution,{invocation_id:second.fields.invocationId,
    realm_id:second.fields.realmId,trigger_id:second.fields.triggerId});
  // The native registry retains completed track:1. Its next declared child is
  // track:2, with the original revision-zero dependency; native commit verifies
  // these exact bytes against the actual preceding create acknowledgement.
  Object.assign(join.arguments.completion_dependency,{id:'completion:track:2:0',
    track:'track:2',invocation:second.fields.invocationId});
  return {initialPublic:{...copy(document.public),timeline:rows},
    records:[stableAlgorithmJSON(firstCreate),decisions[1],...targets,decisions[2],stableAlgorithmJSON(create),
      stableAlgorithmJSON(join),...targets,decisions[2],decisions[3]],
    createOrdinal:7,bootstrapOrdinal:8};
}
