#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {SelectedExecutionHarness} from '../src/training/harness-v4.js';
import {renderOrchestration} from '../src/training/render-orchestration.js';
import {buildSemanticDiagnostics,renderSemanticDiagnosticsHtml} from '../src/training/semantic-diagnostics.js';
const path=process.argv[2];
if(!path)throw new Error('Usage: inspect-selected-harness.mjs EPISODE.json [--report PREFIX] [--expected EXPECTED.json] [--track ID] [--transport]');
const document=JSON.parse(readFileSync(path,'utf8'));
const options={includeTransport:process.argv.includes('--transport')};
const reportAt=process.argv.indexOf('--report'),expectedAt=process.argv.indexOf('--expected'),trackAt=process.argv.indexOf('--track');
if(reportAt>=0){
  const prefix=process.argv[reportAt+1];if(!prefix)throw new Error('--report requires an output prefix');
  const expected=expectedAt>=0?JSON.parse(readFileSync(process.argv[expectedAt+1],'utf8')):null;
  const trackId=trackAt>=0?process.argv[trackAt+1]:null;
  const report=buildSemanticDiagnostics(document,{expected,trackId,...options});
  await writeFile(prefix+'.json',JSON.stringify(report,null,2)+'\n');
  await writeFile(prefix+'.html',renderSemanticDiagnosticsHtml(report));
  process.stdout.write(`Wrote read-only trace diagnostics: ${prefix}.json and ${prefix}.html\nReplay ${report.replayValid?'valid':'invalid'}; retained ${report.records.length} public records.\n`);
  process.exitCode=report.replayValid?0:1;
}else{
const lines=document.orchestration?renderOrchestration(document,options):
  SelectedExecutionHarness.replay(document,{requireTerminal:false}).inspect(null,options);
process.stdout.write(lines.join('\n')+'\n');
}
