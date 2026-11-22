// One isolated technical source family, outside both production populations.
export const moduleSchedulerSourceFixture={
  id:'module-scheduler-source-pack-fixture',family:'module-scheduler-source-pack-fixture',
  entryModule:'main.js',exportName:'run',experimentalSchedulerPlan:true,args:[],
  modules:{
    'left.js':'export let x=0;try {await Promise.reject(7);} catch(e){x=e;}',
    'right.js':'await 0;export const x=2;',
    'main.js':"import {x} from './left.js';import {x as y} from './right.js';export function run(){return x+y;}"
  }
};
