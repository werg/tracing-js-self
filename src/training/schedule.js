// Physical meridian/fragment placement is transport, not guest execution.
import {fragmentWitness} from './format.js';

export function scheduleRecords(compiled,maxBytes){
  const groups=[];
  const append=(mode,logical)=>{
    for(const record of fragmentWitness(logical,{maxBytes}))
      groups.push({id:'m'+(groups.length+1),mode,
        loss:mode==='observed'?'none':'semantic',
        events:[{track:'t0',record}]});
  };
  for(const line of compiled.context)append('observed',line);
  for(const line of compiled.generated)append('generated',line);
  return groups;
}

