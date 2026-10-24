#!/usr/bin/env node
// Inspect previously generated version-three JSONL without oracle leakage.
import {readFileSync,writeFileSync} from 'node:fs';
import {renderWitness} from '../src/training/render-v3.js';
import {restoreWitness,validateWitnessTrainingExport} from '../src/training/export-v3.js';

const [input,output]=process.argv.slice(2);
if(!input)throw new TypeError('Usage: node tools/inspect-witness-v3.mjs corpus.jsonl [report.json]');
const entries=readFileSync(input,'utf8').split('\n').filter(Boolean).map(JSON.parse);
const report=entries.map((episode,index)=>{
  const valid=validateWitnessTrainingExport(episode);
  const context=episode.public.groups.filter(g=>g.mode==='observed').map(g=>g.events[0].record);
  const generated=episode.public.groups.filter(g=>g.mode==='generated').map(g=>g.events[0].record);
  const semantic=[...restoreWitness(context),...restoreWitness(generated)];
  const inspection=semantic.map(renderWitness);
  const source=episode.sidecar.compiled;
  return {index,valid,rawPublicRecords:semantic,renderedInspection:inspection,
    metrics:{logicalRecords:semantic.length-2,
      physicalRecords:episode.public.groups.length,
      publicUtf8Bytes:Buffer.byteLength(semantic.join('\n'),'utf8'),
      privateEvidenceBytes:Buffer.byteLength(JSON.stringify(episode.sidecar),'utf8')},
    privateEvidence:{certificates:source.certificates,elided:source.elided,
      sourceFamily:episode.sidecar.sourceLineage??null},
    admission:episode.sidecar.admission};
});
const serialized=JSON.stringify({schema:'semantic-inspection/3',report},null,2)+'\n';
if(output)writeFileSync(output,serialized);
else process.stdout.write(serialized);
