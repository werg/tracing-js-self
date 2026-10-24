// Public-only causal and visibility audit. No access to private runtime,
// hidden journal counter, reference result, or teacher completion.
import {decodeWitness,restoreWitness} from './format.js';
import {SemanticController} from './controller.js';

export function auditPublicCausality(publicEpisode,{maxBytes=512}={}){
  const groups=publicEpisode?.groups;
  if(!Array.isArray(groups)||groups.length<4)
    throw new TypeError('Missing version-three causal meridians');
  const start=groups.findIndex(g=>g.mode==='generated');
  if(start<2)throw new TypeError('Missing observed source and input');
  for(const [i,group] of groups.entries()){
    if(group?.id!=='m'+(i+1)||!['observed','generated'].includes(group.mode)||
       group.loss!==(group.mode==='observed'?'none':'semantic')||
       !Array.isArray(group.events)||group.events.length!==1||
       group.events[0].track!=='t0'||
       typeof group.events[0].record!=='string'||
       Buffer.byteLength(group.events[0].record,'utf8')>maxBytes)
      throw new TypeError('Invalid v3 meridian, lane, visibility, or transport budget');
  }
  const observed=restoreWitness(groups.slice(0,start).map(g=>g.events[0].record));
  if(observed.length!==2||decodeWitness(observed[0]).kind!=='code'||
     decodeWitness(observed[1]).kind!=='input')
    throw new TypeError('Causally ungrounded initial source/graph');
  const controller=new SemanticController(observed);
  const logical=restoreWitness(groups.slice(start).map(g=>g.events[0].record));
  if(!logical.length)throw new TypeError('Missing selected execution');
  for(const [i,record] of logical.entries()){
    const {kind}=decodeWitness(record);
    if(kind==='code'||kind==='input'||kind==='observe')
      throw new TypeError('Environment-only record appears as a prediction');
    controller.commit(record);
    if(controller.completion&&i!==logical.length-1)
      throw new TypeError('A completed semantic episode predicts a future');
  }
  if(!controller.completion)throw new TypeError('Required terminal end is absent');
  return {valid:true,logicalRecords:logical.length,
    physicalFragments:groups.length,
    firstWitnessViolation:controller.firstWitnessViolation};
}
