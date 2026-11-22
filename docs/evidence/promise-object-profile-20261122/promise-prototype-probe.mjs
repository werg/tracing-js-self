import {createRuntime} from '../worktrees/promise-producer/src/runtime.js';
import {compileProtocolSourceV8} from '../worktrees/promise-producer/src/semantic/protocol-source-compiler-v8.js';
import {compileSourceProjection} from '../worktrees/promise-producer/src/semantic/source-projection.js';
import {SOURCE_PROJECTION_CLIENT_V8} from '../worktrees/promise-producer/src/semantic/source-compiler-v8.js';
import {verifyProtocolRegionTrainingCase} from '../worktrees/promise-producer/src/semantic/protocol-source-v8.js';
import {spawnSync} from 'node:child_process';
const expressions=[
  ['set-null','Object.setPrototypeOf(p,null); return 7;'],
  ['set-object','Object.setPrototypeOf(p,{}); return 7;'],
  ['set-computed','const k="setPrototypeOf"; Object[k](p,null); return 7;'],
  ['get-prototype','Object.getPrototypeOf(p); return 7;'],
  ['get-computed','const k="getPrototypeOf"; Object[k](p); return 7;'],
  ['get-caught','try{Object.getPrototypeOf(p);}catch(error){} return 7;'],
  ['create-prototype','Object.create(p); return 7;'],
  ['set-non-object','Object.setPrototypeOf(p,5); return 7;'],
  ['get-descriptor','Object.getOwnPropertyDescriptor(p,"then"); return 7;'],
  ['freeze','Object.freeze(p); return 7;'],
  ['prevent-extensions','Object.preventExtensions(p); return 7;'],
  ['is-extensible','return Object.isExtensible(p);']
];
for(const [name,body] of expressions){
  const source='"use strict"; async function run(){const p=Promise.resolve(1); '+body+'}';
  const native=spawnSync(process.execPath,['-e',source+';run().then(value=>console.log(JSON.stringify({kind:"return",value})),error=>console.log(JSON.stringify({kind:"throw",name:error.name,message:error.message})));'],{encoding:'utf8',timeout:10000});
  const row={name,source,native:native.stdout.trim()};
  try{const rt=createRuntime().startEntry({text:source,functionName:'run',args:[],allowAsync:true});rt.drive();const bundle=rt.exportRun();
    for(const [key,compile] of [['direct',()=>compileProtocolSourceV8(bundle)],['shared',()=>compileSourceProjection(bundle,{projectionClient:SOURCE_PROJECTION_CLIENT_V8})]]){
      try{row[key]={accepted:true,outcome:compile().outcome};}catch(e){row[key]={accepted:false,category:e.category,reason:e.message};}
    }
    const accepted=await verifyProtocolRegionTrainingCase({source,entry:'run',args:[],family:'promise-prototype-probe:'+name});
    row.full={accepted:!!accepted.exported,category:accepted.category,reason:accepted.reason};
  }catch(e){row.runtimeError=e.message;}
  console.log(JSON.stringify(row));
}
