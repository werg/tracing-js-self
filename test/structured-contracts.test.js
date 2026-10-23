import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {validateBinding,contractArguments,assessReferenceResult}
 from '../src/corpus/structured-reference.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const runGit=(root,...args)=>execFileSync('git',['-C',root,...args],
 {encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'test',
 GIT_AUTHOR_EMAIL:'test@example.org',GIT_COMMITTER_NAME:'test',
 GIT_COMMITTER_EMAIL:'test@example.org'}}).trim();
const sourceRepo=(where,filename,source)=>{
 mkdirSync(where,{recursive:true});
 runGit(where,'init','-q');
 writeFileSync(join(where,filename),source);
 runGit(where,'add','.');
 runGit(where,'commit','-qm','pin test fixture');
 return runGit(where,'rev-parse','HEAD');
};
const mock=(kind,fixture,expected,path,revision,id)=>{
 const program=kind==='json-schema-contract'?{kind,draft:'draft2020-12'}:{kind};
 return {schema:'external-corpus-fixture/1',admitted:false,verified:false,
  id:hash(id),program,fixture,expected,
  provenance:{repository:'example/input',revision,path,sha256:hash(
   kind==='json-schema-contract'?'[]':'[]')}};
};
const cli=resolve('tools/verify-structured-contracts.mjs');
const execute=(dir,binding,rows,extra=[])=>{
 writeFileSync(join(dir,'binding.json'),JSON.stringify(binding));
 writeFileSync(join(dir,'rows.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
 return spawnSync(process.execPath,[cli,'--trusted-execution','--binding',
  join(dir,'binding.json'),'--input',join(dir,'rows.jsonl'),
  '--inputs-root',join(dir,'input'),'--implementation-root',join(dir,'implementation'),
  '--output',join(dir,'out.jsonl'),'--report',join(dir,'report.json'),
  '--timeout-ms','1200',...extra],{encoding:'utf8',timeout:15000});
};
test('structured bindings reject unsupported dialects, paths and fake evidence',()=>{
 const binding={schema:'structured-corpus-binding/1',kind:'json-schema-contract',
  inputRepository:'example/input',inputRevision:'a'.repeat(40),
  implementation:{repository:'example/validator',revision:'b'.repeat(40),
   license:'MIT',file:'lib.mjs',entry:'validate',sha256:'c'.repeat(64)},
  dialects:['draft2020-12']};
 assert.deepEqual(validateBinding(binding).dialects,['draft2020-12']);
 for(const path of ['../escape.js','/tmp/out.js','x\\y.js','foo//bar.mjs']){
  assert.throws(()=>validateBinding({...binding,
   implementation:{...binding.implementation,file:path}}),/Invalid/);
 }
 const good=mock('json-schema-contract',
  {kind:'schema-validation',schema:{type:'string'},data:'ok'},
  {kind:'validity',valid:true},'tests/a.json',binding.inputRevision,'good');
 assert.equal(contractArguments(good,binding).status,'ready');
 assert.equal(contractArguments({...good,admitted:true},binding).status,'unsupported');
 assert.equal(contractArguments({...good,program:{kind:'json-schema-contract',draft:'draft4'}},binding).status,'unsupported');
 assert.equal(assessReferenceResult(binding,true,{
  schema:'structured-reference-worker/1',status:'returned',value:true}).status,'reference-agreed');
 assert.equal(assessReferenceResult(binding,true,{
  schema:'structured-reference-worker/1',status:'returned',value:'true'}).status,'unsupported');
});
test('pinned JSON Schema and CommonMark modules produce strictly non-owned reference checks',()=>{
 const dir=mkdtempSync(join(tmpdir(),'structured-corpus-'));
 try{
  const source='[]',sourcePath='spec.json';
  const inputRevision=sourceRepo(join(dir,'input'),sourcePath,source);
  const moduleText='export function validate(schema,data) { return typeof data === schema.type; }\n'+
   'export function render(markdown) { return "<p>"+markdown+"</p>\\n"; }\n';
  const implementationRevision=sourceRepo(join(dir,'implementation'),'lib.mjs',moduleText);
  const binding={schema:'structured-corpus-binding/1',kind:'json-schema-contract',
   inputRepository:'example/input',inputRevision,
   implementation:{repository:'example/reference',revision:implementationRevision,
    license:'MIT',file:'lib.mjs',entry:'validate',sha256:hash(moduleText)},
   dialects:['draft2020-12']};
  const cases=[
   mock('json-schema-contract',{kind:'schema-validation',schema:{type:'string'},data:'a'},
    {kind:'validity',valid:true},sourcePath,inputRevision,'a'),
   mock('json-schema-contract',{kind:'schema-validation',schema:{type:'string'},data:5},
    {kind:'validity',valid:false},sourcePath,inputRevision,'b'),
   mock('json-schema-contract',{kind:'schema-validation',schema:{type:'string'},data:5},
    {kind:'validity',valid:true},sourcePath,inputRevision,'c'),
   mock('json-schema-contract',{kind:'schema-validation',schema:{type:'string'},data:'a'},
    {kind:'validity',valid:true},sourcePath,inputRevision,'d')
  ];
  cases[3].program.draft='draft4';
  let result=execute(dir,binding,cases);
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(readFileSync(join(dir,'report.json')));
  assert.deepEqual(report.counts,{'reference-agreed':2,failed:1,unsupported:1});
  assert.equal(report.verifiedOwned,0);
  assert.equal(report.admitted,0);
  const rows=readFileSync(join(dir,'out.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert(rows.every(x=>x.authority==='native-v8-diagnostic-only'&&
   x.verifiedOwned===false&&x.admitted===false));
  const markdownBinding={...binding,kind:'commonmark-contract',
   implementation:{...binding.implementation,entry:'render'}};
  delete markdownBinding.dialects;
  const markdown=[mock('commonmark-contract',{kind:'markdown-input',markdown:'hello'},
   {kind:'rendered-html',html:'<p>hello</p>\n'},sourcePath,inputRevision,'markdown')];
  result=execute(dir,markdownBinding,markdown);
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir,'report.json'))).counts['reference-agreed'],1);
  // The implementation and input source are checked byte-for-byte before execution.
  const invalid=execute(dir,{...binding,
   implementation:{...binding.implementation,sha256:'f'.repeat(64)}},cases);
  assert.notEqual(invalid.status,0);
  assert.match(invalid.stderr,/SHA-256 mismatch/);
  cases[0].provenance.sha256='0'.repeat(64);
  assert.notEqual(execute(dir,binding,cases).status,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('dynamic async or hostile workers are refused by a process deadline',()=>{
 const dir=mkdtempSync(join(tmpdir(),'structured-timeout-'));
 try{
  const source='[]';
  const inputRevision=sourceRepo(join(dir,'input'),'spec.json',source);
  const moduleText='export async function validate() { await new Promise(()=>{}); }\n';
  const implementationRevision=sourceRepo(join(dir,'implementation'),'lib.mjs',moduleText);
  const binding={schema:'structured-corpus-binding/1',kind:'json-schema-contract',
   inputRepository:'example/input',inputRevision,
   implementation:{repository:'example/reference',revision:implementationRevision,
    file:'lib.mjs',entry:'validate',sha256:hash(moduleText),license:'MIT'},
   dialects:['draft2020-12']};
  const fixture=[mock('json-schema-contract',
   {kind:'schema-validation',schema:{type:'string'},data:'a'},
   {kind:'validity',valid:true},'spec.json',inputRevision,'timeout')];
  const missingOptIn=execute(dir,binding,fixture,['--other-flag']);
  // The helper supplies the opt-in; test the safety gate separately.
  const unsafe=spawnSync(process.execPath,[cli],{encoding:'utf8'});
  assert.notEqual(unsafe.status,0);
  assert.match(unsafe.stderr,/trusted-execution/);
  assert.equal(missingOptIn.status,0,missingOptIn.stderr);
  const report=JSON.parse(readFileSync(join(dir,'report.json')));
  // A killed or prematurely exited worker is unsupported, never a
  // reference-conformance failure or an admitted success.
  assert.equal(report.counts.unsupported,1);
  assert.equal(report.admitted,0);
  assert.equal(report.verifiedOwned,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
