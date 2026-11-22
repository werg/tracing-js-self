// Teacher-only bridge: fresh original source ownership binds the public ledger.
import {isDeepStrictEqual as eq} from 'node:util';
import {RegionExecutionHarness} from './region-harness.js';
import {encodeProtocolRecordV8} from './protocol-codec-v8.js';
import {verifyBoundModuleSchedulerPlanV8} from './module-scheduler-plan-v8.js';
import {deriveModuleSchedulerSourceCutsV8} from './module-scheduler-source-v8.js';

const copy=structuredClone;
const need=(condition,message)=>{if(!condition)throw new TypeError('Bound module source: '+message);};
function normalized(state,frames=new Map()){
  return Object.fromEntries(Object.entries(state.modules).map(([file,row])=>[file,{status:row.status,
    pendingDependencies:row.pendingDependencies,startOrder:row.startOrder,frameId:frames.get(row.frameId)??row.frameId,
    executionPromiseId:row.executionPromiseId,awaited:row.awaited,completedDependencies:row.completedDependencies,
    failure:row.failure&&{moduleFile:row.failure.moduleFile,promiseId:row.failure.promiseId}}]));
}

export function bindModuleSchedulerSourceProjectionV8({bundle,projection,plan,request,maxGenerated}){
  verifyBoundModuleSchedulerPlanV8(plan,{source:projection.source,entry:projection.entry});
  need(request,'original module request is required');
  const owned=deriveModuleSchedulerSourceCutsV8({request,bundle:JSON.parse(JSON.stringify(bundle))});
  need(eq(owned.plan,plan.modulePlan),'source lifecycle inventory differs from active program plan');
  const initialize={kind:'module.scheduler.initialize',object:'module-ledger',planDigest:plan.digest},
    claims=[{kind:'protocol',record:initialize,line:encodeProtocolRecordV8(initialize),
      certificate:{rule:'source-bound-module-scheduler-initialize/1',journalEvents:[],source:null,planDigest:plan.digest}},
      ...copy(projection.claims)];
  need(claims.length<=maxGenerated,'source record bound');
  const cuts=[],events=new Set(),frames=new Map();
  for(const cut of owned.cuts){
    const eventId=cut.certificate.eventId;
    need(!events.has(eventId),'module lifecycle event has duplicate owners');events.add(eventId);
    const indices=claims.flatMap((claim,index)=>claim.certificate.journalEvents.includes(eventId)?[index]:[]);
    need(indices.length&&indices.every((index,position)=>index===indices[0]+position),
      'owned module event does not map to one exact public transaction');
    if(cut.action.type==='module.start'){
      const calls=indices.map(index=>claims[index].record).filter(record=>['call','async.call'].includes(record.kind));
      need(calls.length===1,'module driver must enter exactly one public source scope');
      frames.set(cut.action.frameId,calls[0].child);
    }
    cuts.push({cut,indices});
  }
  const harness=new RegionExecutionHarness({sessionId:'bound-module-source',automaticDelivery:false,now:()=>-Infinity,maxGenerated});
  harness.publishProgram({programId:'program1',source:projection.source,entry:projection.entry,moduleSchedulerPlan:plan,capabilities:[]});
  harness.admitInvocation({programId:'program1',invocationId:'invocation1',trackId:'worker1',realmId:'realm1',triggerId:'module-entry',
    inputGraph:projection.inputGraph,realmPolicy:'fresh',completionPolicy:projection.completionPolicy});
  for(const [index,claim]of claims.entries()){
    harness.select('invocation1',claim.line);
    for(const {cut,indices}of cuts.filter(row=>row.indices.at(-1)===index)){
      const ledger=[...harness.controller.heap.values()].find(node=>node.kind==='module-scheduler');
      need(eq(normalized(ledger.state),normalized(cut.after,frames)),'public lifecycle differs from fresh original source');
    }
  }
  need(eq({kind:harness.controller.completion.kind,graph:harness.controller.observedGraph()},projection.outcome),
    'bound public outcome differs from source projection');
  return {...projection,claims,sourceProfile:'bound-module-scheduler-source/1',
    extensions:[...projection.extensions,'bound-module-scheduler-source/1'].sort(),protocolRecords:projection.protocolRecords+1,
    moduleSchedulerOwnership:{schema:'bound-module-source-ownership/1',planDigest:plan.digest,ownedEventCount:events.size,
      cuts:cuts.map(({cut,indices})=>({certificate:copy(cut.certificate),action:copy(cut.action),sourceClaims:indices}))}};
}
