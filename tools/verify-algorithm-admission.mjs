#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {recheckAlgorithmEvidence} from '../src/semantic/compiler.js';

try{
  if(process.argv.length!==3)throw new TypeError('Usage: verify-algorithm-admission.mjs EPISODE.json');
  const exported=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const result=await recheckAlgorithmEvidence(exported,{requireAdmitted:false});
  process.stdout.write(JSON.stringify(result.source)+'\n');
}catch(error){process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;}
