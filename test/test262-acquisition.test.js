import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {acquireTest262GitSnapshot,discoverTest262ModuleDependencies} from '../src/conformance/test262-acquisition.js';
import {buildTest262Catalog} from '../src/conformance/test262-catalog.js';

const fixture=(body='',metadata='')=>`/*---\ndescription: synthetic acquisition control\n${metadata}---*/\n${body}`;

test('exact Git acquisition freezes the full test/harness tree and verifies checkout bytes',()=>{
  const directory=mkdtempSync(join(process.cwd(),'test262-acquisition-'));
  const git=args=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try{
    git(['init','--quiet']);
    const files={
      'test/main.js':fixture('import "./dep_FIXTURE.js";','flags: [module]\n'),
      'test/dep_FIXTURE.js':'export const value=1;',
      'test/bytes.bin':Buffer.from([0xff,0,1]),
      'harness/sta.js':'function Test262Error(){}',
      'harness/assert.js':'function assert(){}',
      'README.md':'Synthetic Git repository for a qualification control.'
    };
    for(const [path,bytes] of Object.entries(files)){
      mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),bytes);
    }
    git(['add','.']);
    git(['-c','user.name=Conformance Control','-c','user.email=conformance@example.invalid',
      'commit','--quiet','-m','Pinned synthetic suite']);
    const revision=git(['rev-parse','HEAD']);
    const {snapshot,sources}=acquireTest262GitSnapshot({suiteRoot:directory,revision});
    assert.equal(Object.keys(snapshot.files).length,5);
    assert.equal(snapshot.acquisition.fullUpstreamTree,true);
    assert(!Object.hasOwn(snapshot.files,'README.md'));
    const catalog=buildTest262Catalog({snapshot,sources,
      profile:{name:'control',edition:'ECMAScript 2026',specification:null,parser:{name:'acorn'},
        hostProfile:{name:'synthetic'},resourcePolicy:{maxSteps:10,maxSourceBytes:1024}},
      moduleDependencies:discoverTest262ModuleDependencies(sources)});
    assert.equal(catalog.summary.testFiles,1);
    assert.equal(catalog.summary.fixtureFiles,1);
    assert.equal(catalog.summary.resourceFiles,1);
    assert.equal(catalog.variants[0].dependencies.status,'complete');
    assert.equal(catalog.claims.fullSuiteAcquired,true);
    assert.equal(catalog.claims.ownedConformance,false);
    assert.throws(()=>acquireTest262GitSnapshot({suiteRoot:directory,revision:'0'.repeat(40)}),/HEAD differs/);
    writeFileSync(join(directory,'test/main.js'),fixture('throw 7;','flags: [module]\n'));
    assert.throws(()=>acquireTest262GitSnapshot({suiteRoot:directory,revision}),/bytes differ/);
    unlinkSync(join(directory,'test/main.js'));
    symlinkSync('dep_FIXTURE.js',join(directory,'test/main.js'));
    assert.throws(()=>acquireTest262GitSnapshot({suiteRoot:directory,revision}),/symbolic link/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('module discovery preserves cycles, missing imports and computed requests explicitly',()=>{
  const sources={
    'test/main.js':fixture('import "./a_FIXTURE.js";import("./b_FIXTURE.js");import(choice);','flags: [module]\n'),
    'test/a_FIXTURE.js':'export * from "./main.js";',
    'test/b_FIXTURE.js':'import "./missing.js";',
    'test/invalid.js':fixture('export {','flags: [module]\n'),
    'test/script.js':fixture('import("./ignored.js");')
  };
  const dependencies=discoverTest262ModuleDependencies(sources);
  assert.deepEqual(dependencies['test/main.js'].paths,['test/a_FIXTURE.js','test/b_FIXTURE.js']);
  assert.match(dependencies['test/main.js'].unresolved[0],/Computed dynamic import/);
  assert.deepEqual(dependencies['test/a_FIXTURE.js'].paths,['test/main.js']);
  assert.match(dependencies['test/b_FIXTURE.js'].unresolved[0],/Missing module request/);
  assert.match(dependencies['test/invalid.js'].unresolved[0],/Module parser/);
  assert(!Object.hasOwn(dependencies,'test/script.js'));
});
