#!/usr/bin/env node
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildCapabilityLedger} from '../src/training/capability-ledger.js';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out')throw new Error('Usage: node tools/generate-capability-ledger.mjs --out report.json');
const output=resolve(args[1]);
const producerRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const report=await buildCapabilityLedger({producerRevision});
mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({output,totals:report.totals,optimizerSteps:0,learnedSuccess:null}));
