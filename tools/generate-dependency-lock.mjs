#!/usr/bin/env node
// npm ci consumes the root lock. npm pack includes this exact-byte evidence
// under an ordinary publishable name, without invoking a lifecycle hook.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const args=process.argv.slice(2);
if(args.length>1||args.length===1&&args[0]!=='--check')
  throw new TypeError('Usage: node tools/generate-dependency-lock.mjs [--check]');
const source=readFileSync(new URL('../package-lock.json',import.meta.url)),
  target=new URL('../contracts/npm-lock.json',import.meta.url);
if(args.includes('--check')){
  if(!source.equals(readFileSync(target)))
    throw new Error('Packaged dependency evidence differs from package-lock.json; run node tools/generate-dependency-lock.mjs');
}else writeFileSync(target,source);
console.log(JSON.stringify({valid:true,path:'contracts/npm-lock.json',sha256:createHash('sha256').update(source).digest('hex')}));
