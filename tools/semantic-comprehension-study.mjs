#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {LANGUAGE_EXPANSION_COMPREHENSION_TASKSET as taskset} from '../fixtures/language-expansion/comprehension.js';
import {freezeComprehensionStudy,scoreFrozenComprehensionStudy} from '../src/semantic/comprehension-study.js';
const allowed=new Set(['--out','--model-id','--model-revision','--settings','--prompt','--cohort','--seed','--phase','--margin','--study','--responses']);
const flags=new Map();for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];
  if(!allowed.has(key)||flags.has(key)||!value||value.startsWith('--'))throw new Error('Unknown, repeated or missing study option '+key);flags.set(key,value);}
if(!flags.has('--out'))throw new Error('Required --out NEW_FILE; prepare with --model-id --model-revision --settings JSON --prompt TEXT, or score --study JSON --responses JSON');
const read=key=>JSON.parse(readFileSync(resolve(flags.get(key)),'utf8'));let output;
if(flags.has('--responses')){
  if(!flags.has('--study'))throw new Error('Responses require the frozen --study file');
  output=scoreFrozenComprehensionStudy(taskset,read('--study'),read('--responses'));
}else{
  for(const key of ['--model-id','--model-revision','--settings','--prompt'])if(!flags.has(key))throw new Error('Required frozen setting '+key);
  output=freezeComprehensionStudy(taskset,{model:{id:flags.get('--model-id'),revision:flags.get('--model-revision')},
    settings:read('--settings'),prompt:readFileSync(resolve(flags.get('--prompt')),'utf8'),cohort:Number(flags.get('--cohort')??0),
    seed:Number(flags.get('--seed')??17),phase:flags.get('--phase')??'pilot',
    noninferiorityMargin:flags.has('--margin')?Number(flags.get('--margin')):null});
}
const path=resolve(flags.get('--out'));mkdirSync(dirname(path),{recursive:true});
writeFileSync(path,JSON.stringify(output,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output:path,status:output.status,digest:output.digest??output.studyDigest}));
