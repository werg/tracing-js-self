#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hostOperationContract} from '../src/host/operations.js';

const target=resolve(dirname(fileURLToPath(import.meta.url)),
  '../contracts/host-operations-v4.json');
const bytes=JSON.stringify(hostOperationContract(),null,2)+'\n';
if(process.argv.includes('--check')){
  if(readFileSync(target,'utf8')!==bytes)throw new Error('Shared capability contract needs regeneration');
}else{mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes);}
