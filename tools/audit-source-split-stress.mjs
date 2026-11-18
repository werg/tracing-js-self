#!/usr/bin/env node
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {auditSourceSplitStress} from '../src/corpus/source-split-stress.mjs';

const {values}=parseArgs({options:{registry:{type:'string'},out:{type:'string'},
  'max-sources':{type:'string'},'max-component-share':{type:'string'},'benchmark-families':{type:'string'}}});
if(!values.registry||!values.out)throw new Error('Usage: audit-source-split-stress.mjs --registry FROZEN.json --out NEW.json [--max-sources 64 --max-component-share 0.20 --benchmark-families JSON_ARRAY_FILE]');
const output=resolve(values.out);if(existsSync(output))throw new Error('Use a new report path; frozen evidence is immutable');
const registry=JSON.parse(readFileSync(resolve(values.registry),'utf8'));
const report=auditSourceSplitStress(registry,{maxSources:Number(values['max-sources']??64),
  maxComponentShare:Number(values['max-component-share']??.2),
  benchmarkFamilies:values['benchmark-families']?JSON.parse(readFileSync(resolve(values['benchmark-families']),'utf8')):[]});
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,counts:report.counts,report:output}));
if(report.status==='failed')process.exitCode=1;
