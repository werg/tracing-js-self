#!/usr/bin/env node
// Bounded mutation campaign against the running TEACHER implementation. The
// journal is never edited. Replay uses the same faulty implementation; V8 does
// not. This tool must run serially in a dedicated process.
import {createRuntime} from '../src/runtime.js';
import {verifyEffectfulTrainingCase} from '../src/training/effectful-admit.js';
import {createHash} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const wrap=body=>'"use strict";function run(){'+body+'}';
export const TEACHER_MUTANTS=[
  {id:'overwritten-initializer-storage',category:'initialization',source:wrap('let x=1;x=0;return x;'),storeInitializer:true},
  {id:'overwritten-cell',category:'binding',source:wrap('let x=0;x=2;x=0;return x;'),literal:'x=2'},
  {id:'overwritten-property',category:'property',source:wrap('const box={x:0};box.x=2;box.x=0;return box.x;'),literal:'box.x=2'},
  {id:'overwritten-numeric-property-storage',category:'property',source:wrap('const box=[0];box[0]=2;box[0]=0;return box[0];'),storeProperty:'0'},
  {id:'dropped-property-storage',category:'property',source:wrap('const box={x:0};box.x=2;box.x=0;return box.x;'),dropProperty:'x'},
  {id:'dropped-cell-storage',category:'binding',source:wrap('let x=0;x=2;x=0;return x;'),dropBinding:'x'},
  {id:'compound-cell-storage',category:'binding',source:wrap('let x=0;x+=2;x=0;return x;'),storeBinding:'x'},
  {id:'compound-numeric-property-storage',category:'property',source:wrap('const box=[0];box[0]+=2;box[0]=0;return box[0];'),storeProperty:'0'},
  {id:'caught-value-storage',category:'exception',source:wrap('try{throw 1;}catch(e){}return 0;'),storeCatch:'e'},
  {id:'input-reference-substitution',category:'alias',source:'"use strict";function run(a,b){let x=a;x=0;return x;}',
    args:[{value:1},{value:1}],substituteInputReference:true},
  {id:'overwritten-call-result',category:'call',source:'"use strict";function helper(){return 2;}function run(){let x=helper();x=0;return x;}',literal:'return 2'},
  {id:'omitted-strict-exception',category:'exception',source:wrap('const box={};Object.defineProperty(box,"x",{get:()=>1});let x=0;try{x=(box.x=2);}catch(e){x=7;}x=0;return x;'),strict:false},
  {id:'skipped-finally',category:'finally',source:wrap('let x=0;try{return 0;}finally{x=2;x=0;}'),skipFinally:true}
];

async function executeMutant(fixture){
  const prototype=Object.getPrototypeOf(createRuntime()),step=prototype.step,route=prototype.routeCompletion,commit=prototype.commit;
  const target=fixture.literal?fixture.source.indexOf(fixture.literal)+fixture.literal.length-1:null;
  let activations=0;
  prototype.commit=function(operation,callback,metadata){
    return commit.call(this,operation,(draft,eventId)=>{
      const detail=callback(draft,eventId);
      if(fixture.storeInitializer&&operation==='binding.initialize'){
        for(const environment of Object.values(draft.envs)){
          const cell=environment.bindings.x;
          if(cell?.initialized&&cell.token?.value?.[1]===1){cell.token.value=['num',99];activations++;}
        }
      }
      if(operation==='property.write'&&(fixture.storeProperty||fixture.dropProperty)){
        const key=fixture.storeProperty??fixture.dropProperty;
        for(const object of Object.values(draft.heap))if(object.properties?.[key]?.value?.[0]==='num'&&
          object.properties[key].value[1]===2){
          if(fixture.storeProperty)object.properties[key].value=['num',99];
          else if(this.state.heap[object.id])draft.heap[object.id]=structuredClone(this.state.heap[object.id]);
          activations++;
        }
      }
      if(operation==='binding.write'&&(fixture.storeBinding||fixture.dropBinding)){
        const name=fixture.storeBinding??fixture.dropBinding;
        for(const environment of Object.values(draft.envs))if(environment.bindings[name]?.token?.value?.[0]==='num'&&
          environment.bindings[name].token.value[1]===2){
          if(fixture.storeBinding)environment.bindings[name].token.value=['num',99];
          else environment.bindings[name]=structuredClone(this.state.envs[environment.id].bindings[name]);
          activations++;
        }
      }
      if(fixture.storeCatch&&operation==='completion.catch.bind'){
        for(const environment of Object.values(draft.envs)){
          const cell=environment.bindings[fixture.storeCatch];
          if(cell?.token?.value?.[0]==='num'&&cell.token.value[1]===1){cell.token.value=['num',99];activations++;}
        }
      }
      if(fixture.substituteInputReference&&operation==='binding.initialize'){
        for(const environment of Object.values(draft.envs))if(environment.bindings.x?.token?.value?.[0]==='ref'&&environment.bindings.b){
          environment.bindings.x.token.value=structuredClone(environment.bindings.b.token.value);activations++;
        }
      }
      return detail;
    },metadata);
  };
  prototype.step=function(){
    const frame=this.state.frames[this.state.control.a0.activeFrameId];
    const program=frame&&this.programs[frame.codeId],instruction=program?.instructions[frame.pc];
    if(instruction?.op==='CONST'&&instruction.start===target){
      const original=instruction.arg.value;instruction.arg.value=['num',3];activations++;
      try{return step.call(this);}finally{instruction.arg.value=original;}
    }
    if(fixture.strict===false&&instruction?.op==='PUT_PROP'){
      const original=program.strict;program.strict=false;activations++;
      try{return step.call(this);}finally{program.strict=original;}
    }
    return step.call(this);
  };
  prototype.routeCompletion=function(draft,frame,completion,eventId){
    if(fixture.skipFinally&&completion.type==='return')for(const handler of frame.handlers){
      if(handler.finallyPc!==null){handler.finallyPc=null;activations++;}
    }
    return route.call(this,draft,frame,completion,eventId);
  };
  try{return {result:await verifyEffectfulTrainingCase({source:fixture.source,entry:'run',
    args:fixture.args??[],family:'teacher-mutation-'+fixture.id,fixture:{calls:[]}}),activations:()=>activations};}
  finally{prototype.step=step;prototype.routeCompletion=route;prototype.commit=commit;}
}

export async function auditTeacherMutations(){
  const rows=[];
  for(const fixture of TEACHER_MUTANTS){
    const control=await verifyEffectfulTrainingCase({source:fixture.source,entry:'run',
      args:fixture.args??[],family:'teacher-mutation-'+fixture.id,fixture:{calls:[]}});
    const {result,activations}=await executeMutant(fixture);
    rows.push({id:fixture.id,category:fixture.category,source:fixture.source,
      sourceDigest:createHash('sha256').update(fixture.source).digest('hex'),args:fixture.args??[],
      control:control.status,mutant:result.status,mutationActivations:activations(),
      caughtIndependently:result.status==='reference_completion_mismatch',
      finalOutcomeStillAgrees:result.failure?.original.observations.owned?.outcome!==undefined&&
        JSON.stringify(result.failure.original.observations.owned.outcome)===JSON.stringify(result.failure.original.observations.original?.outcome),
      firstDivergence:result.failure?.original.error.details??null});
  }
  return {schema:'teacher-semantic-mutation-campaign/1',scope:rows.length+' bounded implementation mutants; no completeness claim',
    journalEdited:false,independentAuthority:'uninstrumented-and-instrumented-node-v8-source',
    attempted:rows.length,detectedIndependently:rows.filter(row=>row.caughtIndependently).length,
    passed:rows.every(row=>row.control==='locally_verified'&&row.mutationActivations>0&&row.caughtIndependently&&row.finalOutcomeStillAgrees),rows};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  if(args.length!==0&&(args.length!==2||args[0]!=='--out'))throw new TypeError('Usage: audit-teacher-mutations.mjs [--out file.json]');
  const result=await auditTeacherMutations();
  if(args[1]){mkdirSync(dirname(resolve(args[1])),{recursive:true});writeFileSync(args[1],JSON.stringify(result,null,2)+'\n',{flag:'wx'});}
  console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
