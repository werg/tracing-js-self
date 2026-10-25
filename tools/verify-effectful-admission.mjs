#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {recheckEffectfulAdmission} from '../src/training/effectful-admit.js';

try{
  const filename=process.argv[2];
  if(!filename)throw new TypeError('Usage: verify-effectful-admission.mjs EPISODE.json');
  const exported=JSON.parse(readFileSync(filename,'utf8'));
  const receipt=await recheckEffectfulAdmission(exported);
  if(!/^[0-9a-f]{40}$/.test(receipt.producerRevision??''))
    throw new Error('A pinned producer commit is required for production admission');
  process.stdout.write(JSON.stringify(receipt)+'\n');
}catch(error){process.stderr.write(String(error.stack??error)+'\n');process.exitCode=1;}
