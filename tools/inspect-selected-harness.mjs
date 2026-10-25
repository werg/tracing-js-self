#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {renderOrchestration} from '../src/training/render-orchestration.js';
const path=process.argv[2];
if(!path)throw new Error('Usage: inspect-selected-harness.mjs EPISODE.json');
const document=JSON.parse(readFileSync(path,'utf8'));
const options={includeTransport:process.argv.includes('--transport')};
const lines=document.orchestration?renderOrchestration(document,options):
  SelectedExecutionHarness.replay(document).inspect(null,options);
process.stdout.write(lines.join('\n')+'\n');
