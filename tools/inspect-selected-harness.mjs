#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
const path=process.argv[2];
if(!path)throw new Error('Usage: inspect-selected-harness.mjs EPISODE.json');
const h=SelectedExecutionHarness.replay(JSON.parse(readFileSync(path,'utf8')));
process.stdout.write(h.inspect(null,{includeTransport:process.argv.includes('--transport')}).join('\n')+'\n');
