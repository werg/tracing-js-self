import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRuntime} from '../src/runtime.js';
import {CampaignStore} from '../src/corpus/campaign-store.mjs';
import {auditAffectedAssignments,summarizeAffectedAssignments} from '../src/training/affected-assignment-audit.js';
import {auditInput} from '../tools/audit-affected-assignments.mjs';

const source=body=>'"use strict";function run(){'+body+'}';
const own='const box={};Object.defineProperty(box,"x",{get:()=>1});';
const inherited='const parent={};Object.defineProperty(parent,"x",{get:()=>1});const box=Object.create(parent);';
const overwrite='let answer=0;try{answer=(box.x=2);}catch(e){answer=7;}answer=0;return answer;';
function archive(body,{mutant=false}={}){
  const runtime=createRuntime().startEntry({text:source(body),functionName:'run'});
  // Exercise the historical wrong teacher behavior before generation. Do not
  // fabricate post-generation journal entries: structure alone accepts it.
  if(mutant)for(const program of Object.values(runtime.programs))program.strict=false;
  assert.equal(runtime.drive().kind,'terminated');
  return runtime.exportRun();
}
function temporary(t){
  const path=mkdtempSync(join(tmpdir(),'strict-assignment-audit-'));
  t.after(()=>rmSync(path,{recursive:true,force:true}));return path;
}

test('audit finds historical strict getter-only writes even when final values conceal them',()=>{
  for(const setup of [own,inherited]){
    const bundle=archive(setup+overwrite,{mutant:true}),original=JSON.stringify(bundle);
    const row=auditAffectedAssignments(bundle,{id:'case'});
    assert.equal(row.status,'affected_path_observed');
    assert.equal(row.affectedEvents.length,1);
    assert.equal(row.affectedEvents[0].suspectedSilentFailure,true);
    assert.equal(row.affectedEvents[0].inherited,setup===inherited);
    assert.deepEqual(row.affectedEvents[0].recordedResult,['num',2]);
    assert.equal(row.independentRequalification,false);
    assert.equal(JSON.stringify(bundle),original,'inventory must not rewrite historical evidence');
  }
});

test('fixed failed assignments remain on the affected-path requalification inventory',()=>{
  const row=auditAffectedAssignments(archive(own+overwrite));
  assert.equal(row.status,'affected_path_observed');
  assert.equal(row.affectedEvents[0].recordedCompletion,'throw');
  assert.equal(row.affectedEvents[0].recordedErrorType,'TypeError');
  assert.equal(row.affectedEvents[0].suspectedSilentFailure,false);
  assert.equal(row.action,'requalify_from_original_source_and_inputs');
});

test('audit uses pre-state descriptors rather than source spellings or the final heap',()=>{
  const bundle=archive('const box={};const define=Object.defineProperty;'+
    'define(box,"x",{get:()=>1,configurable:true});'+
    'const alias=box;alias.x=2;define(box,"x",{set:v=>{}});alias.x=3;return 0;',{mutant:true});
  const row=auditAffectedAssignments(bundle);
  assert.equal(row.affectedEvents.length,1);
  assert.deepEqual(row.affectedEvents[0].rhs,['num',2]);
});

test('own data shadowing, working setters and unexecuted writes are not affected paths',()=>{
  for(const body of [
    'const parent={};Object.defineProperty(parent,"x",{get:()=>1});'+
      'const box={x:3};Object.setPrototypeOf(box,parent);box.x=2;return 0;',
    'const box={};Object.defineProperty(box,"x",{get:()=>1,set:v=>{}});box.x=2;return 0;',
    own+'return 0;box.x=2;'
  ]){
    const row=auditAffectedAssignments(archive(body));
    assert.equal(row.status,'no_affected_path_observed');
    assert.deepEqual(row.affectedEvents,[]);
  }
});

test('audit derives strictness from lexical source scopes, including sloppy callers',()=>{
  const setup='function getter(){return 1;}const box={};Object.defineProperty(box,"x",{get:getter});';
  for(const [body,count] of [
    ['function write(){box.x=2;}function run(){"use strict";write();}run();',0],
    ['function write(){"use strict";try{box.x=2;}catch(e){}}write();',1],
    ['function write(){("use strict");box.x=2;}write();',0]
  ]){
    const runtime=createRuntime().start(setup+body);runtime.drive();
    const row=auditAffectedAssignments(runtime.exportRun());
    assert.equal(row.affectedEvents.length,count);
    assert.equal(row.sloppyGetterOnlyEvents,1-count);
  }
});

test('missing or invalid private archives are not reported as clean or certified',()=>{
  const missing=auditAffectedAssignments({public:{timeline:[]},sidecar:{producerRevision:'a'.repeat(40)}});
  assert.equal(missing.status,'not_audited');
  const broken=archive('return 0;');broken.events[0].sequence=99;
  const invalid=auditAffectedAssignments(broken,{id:'invalid'});
  assert.equal(invalid.status,'not_audited');
  assert.equal(invalid.action,'quarantine_invalid_evidence');
  const report=summarizeAffectedAssignments([missing,invalid]);
  assert.equal(report.counts.rows,2);
  assert.equal(report.counts.notAudited,2);
  assert.deepEqual(report.quarantineList,['episode','invalid']);
  assert.equal(report.nativeAdmission,false);
  assert.throws(()=>summarizeAffectedAssignments([missing,missing]),/unique/);
});

test('campaign audit retains every positive attempt and original denominator',async t=>{
  const dir=temporary(t),store=new CampaignStore(dir,{producer:'a'.repeat(40)});
  const candidate={source:source(own+overwrite),args:[]};
  const exported={public:{timeline:[]},sidecar:{archive:archive(own+overwrite,{mutant:true}),producerRevision:'a'.repeat(40)}};
  store.record('affected',candidate,{status:'locally_verified',exported});
  store.record('affected',candidate,{status:'locally_verified',exported});
  store.record('missing',candidate,{status:'locally_verified'});
  store.record('unsupported',{source:'unsupported'},{status:'unsupported'});
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({producerRevision:'a'.repeat(40),
    campaign:{identityDigest:store.identityDigest},cases:[...store.latest.values()].map(row=>({
      id:row.id,candidateDigest:row.candidateDigest,status:row.status}))}));
  store.close();
  const before=readFileSync(join(dir,'campaign.jsonl'));
  const report=await auditInput(dir);
  assert.equal(report.inventory.attempts,4);
  assert.equal(report.inventory.candidates,3);
  assert.equal(report.inventory.nonPositiveAttempts,1);
  assert.equal(report.counts.rows,3);
  assert.equal(report.counts.affectedRows,2);
  assert.equal(report.counts.notAudited,1);
  assert.deepEqual(report.requalificationList,['affected#1','affected#2']);
  assert.deepEqual(report.quarantineList,['missing#1']);
  assert.deepEqual(readFileSync(join(dir,'campaign.jsonl')),before);
});

test('CLI creates a new receipt and refuses to overwrite any existing evidence',t=>{
  const dir=temporary(t),input=join(dir,'episode.json'),out=join(dir,'audit.json');
  const bytes=JSON.stringify(archive(own+overwrite,{mutant:true}));writeFileSync(input,bytes);
  const cli=new URL('../tools/audit-affected-assignments.mjs',import.meta.url);
  const first=spawnSync(process.execPath,[cli.pathname,'--input',input,'--out',out],{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);
  assert.equal(JSON.parse(readFileSync(out)).counts.affectedRows,1);
  const second=spawnSync(process.execPath,[cli.pathname,'--input',input,'--out',input],{encoding:'utf8'});
  assert.notEqual(second.status,0);
  assert.match(second.stderr,/must be a new file/);
  assert.equal(readFileSync(input,'utf8'),bytes);
});

test('literal definitions and private initialization are classified separately from ordinary Set',()=>{
  for(const body of ['const box={x:1,get y(){return 2;}};return box.x;',
    'class C {#x=1;x=2;set(v){this.#x=v;}}const c=new C();c.set(3);return c.x;']){
    const row=auditAffectedAssignments(archive(body));
    assert.equal(row.status,'no_affected_path_observed');
    assert.deepEqual(row.uncertainEvents,[]);
  }
});
test('Symbol and escaped string keys retain exact descriptor identity in the audit',()=>{
  for(const key of ['Symbol("x")','"\\0symbol:x"','"\\0string:x"']){
    const bundle=archive('const key='+key+';const box={};Object.defineProperty(box,key,{get:()=>1});try{box[key]=2;}catch(e){}return 0;');
    const row=auditAffectedAssignments(bundle);
    assert.equal(row.status,'affected_path_observed');
    assert.equal(row.affectedEvents.length,1);assert.deepEqual(row.uncertainEvents,[]);
  }
});
