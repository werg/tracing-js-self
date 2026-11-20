#!/usr/bin/env node
// Current interoperability bytes are rebuilt from source; historical receipts
// and their code pins are never reused as qualification of a changed runtime.
import {readFile,writeFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import {SEMANTIC_GALLERY_FIXTURES} from '../src/training/semantic-trace-gallery.js';
import {verifyRegionTrainingCase,recheckRegionEvidence} from '../src/semantic/compiler-v8.js';
import {hashAlgorithmData} from '../src/semantic/program.js';

const args=process.argv.slice(2),check=args.includes('--check');
if(args.some(arg=>arg!=='--check'))throw new Error('Usage: node tools/generate-semantic-callback-fixtures.mjs [--check]');
const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id==='callback-captured-write');
const result=await verifyRegionTrainingCase(fixture);
if(!result.exported)throw new Error('Callback fixture source did not qualify: '+result.reason);
const verified=await recheckRegionEvidence(result.exported);
if(!verified.sourceValidated||!verified.projectionValidated||!verified.replayValidated)
  throw new Error('Callback fixture fresh source/public checks failed');
// Retain stable interoperability inputs/outputs. Private source receipts bind
// the current implementation and are freshly rerun above, never relabeled.
const artifact={schema:'semantic-callback-interoperability/1',fixtureId:fixture.id,
  sourceInputDigest:hashAlgorithmData(fixture),
  qualification:{source:'checked-during-generation',public:'replayed',native:'untested',model:'unmeasured'},
  public:result.exported.public,contexts:result.exported.contexts};
const path=new URL('../test/fixtures/semantic-callback-regions-v8.json.gz.b64',import.meta.url);
const bytes=gzipSync(Buffer.from(JSON.stringify(artifact)+'\n')).toString('base64')+'\n';
if(check){if(await readFile(path,'utf8')!==bytes)throw new Error('Regenerate '+path.pathname);}
else await writeFile(path,bytes);
console.log(JSON.stringify({valid:true,mode:check?'checked':'generated',fixture:fixture.id,
  publicDigest:hashAlgorithmData(artifact.public),contextDigest:hashAlgorithmData(artifact.contexts)}));
