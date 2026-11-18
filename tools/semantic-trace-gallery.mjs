// node tools/semantic-trace-gallery.mjs --out <directory> [--case <id> ...]
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {SEMANTIC_GALLERY_FIXTURES,buildSemanticTraceGallery,
  renderSemanticTraceGallery} from '../src/training/semantic-trace-gallery.js';

let out=null,tokenizer=null,compact=false;const selected=[];
for(let index=2;index<process.argv.length;index++){
  const argument=process.argv[index];
  const value=()=>{const next=process.argv[++index];if(!next||next.startsWith('--'))throw Error('Missing value for '+argument);return next;};
  if(argument==='--out')out=resolve(value());
  else if(argument==='--case')selected.push(value());
  else if(argument==='--tokenizer-module')tokenizer=await import(pathToFileURL(resolve(value())).href);
  else if(argument==='--local-state-compaction')compact=true;
  else throw Error('Unknown option '+argument);
}
if(!out)throw Error('Usage: node tools/semantic-trace-gallery.mjs --out <directory> [--case <id>] [--tokenizer-module <pinned-adapter.mjs>] [--local-state-compaction]');
const fixtures=selected.length?selected.map(id=>{
  const fixture=SEMANTIC_GALLERY_FIXTURES.find(row=>row.id===id);
  if(!fixture)throw Error('Unknown gallery fixture '+id);return fixture;
}):SEMANTIC_GALLERY_FIXTURES;
const gallery=await buildSemanticTraceGallery({fixtures,tokenizer,
  projectionOptions:compact?{localStateCompaction:true}:{}});
await mkdir(out,{recursive:true});
await writeFile(join(out,'gallery.json'),JSON.stringify(gallery,null,2)+'\n');
await writeFile(join(out,'gallery.md'),renderSemanticTraceGallery(gallery));
console.log(JSON.stringify({schema:gallery.schema,out,...gallery.totals,categories:gallery.categories}));
