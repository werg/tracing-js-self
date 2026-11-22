import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

test('concurrent imports await the tracked promise after Node marks a TLA module evaluated',()=>{
  const coordinatorUrl=pathToFileURL(resolve('src/conformance/test262-module-evaluation.js')).href;
  const source=`
    import assert from 'node:assert/strict';
    import * as vm from 'node:vm';
    import {createModuleEvaluationCoordinator} from ${JSON.stringify(coordinatorUrl)};
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const context=vm.createContext({__gate:gate});
    const module=new vm.SourceTextModule('await globalThis.__gate;export const value=42;',{
      context,identifier:'test262://test/delayed_FIXTURE.js'
    });
    const coordinator=createModuleEvaluationCoordinator({linker:()=>{
      throw new Error('Unexpected dependency request in gate fixture');
    },timeout:1000,refuse:reason=>new Error(reason)});
    let firstSettled=false;
    const first=coordinator.evaluateOnce(module).then(value=>{firstSettled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(module.status,'evaluated');
    assert.equal(firstSettled,false,'top-level await remains blocked on guest Promise');
    let secondSettled=false;
    const second=coordinator.evaluateOnce(module).then(value=>{secondSettled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(secondSettled,false,'concurrent import must share pending evaluation');
    release(0);
    const [firstModule,secondModule]=await Promise.all([first,second]);
    assert.equal(firstModule.status,'evaluated');
    assert.strictEqual(secondModule,firstModule);
    assert.equal(firstModule.namespace.value,42);
    process.stdout.write('tla-pending-imports-reconciled');
  `;
  const output=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','--eval',source],
    {encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  assert.equal(output,'tla-pending-imports-reconciled');
});

test('imports await an untracked static dependency TLA completion promise',()=>{
  const coordinatorUrl=pathToFileURL(resolve('src/conformance/test262-module-evaluation.js')).href;
  const source=`
    import assert from 'node:assert/strict';
    import * as vm from 'node:vm';
    import {createModuleEvaluationCoordinator} from ${JSON.stringify(coordinatorUrl)};
    let release;
    const gate=new Promise(resolve=>{release=resolve;});
    const context=vm.createContext({__gate:gate});
    const dependency=new vm.SourceTextModule(
      'await globalThis.__gate;export const value=84;',
      {context,identifier:'test262://test/static-delayed_FIXTURE.js'}
    );
    const entry=new vm.SourceTextModule(
      'import {value} from "./static-delayed_FIXTURE.js";export {value};',
      {context,identifier:'test262://test/static-entry_FIXTURE.js'}
    );
    const coordinator=createModuleEvaluationCoordinator({linker:specifier=>{
      if(specifier==='test262://test/static-delayed_FIXTURE.js'||specifier==='./static-delayed_FIXTURE.js')
        return dependency;
      throw new Error('Unexpected dependency request: '+specifier);
    },timeout:1000,refuse:reason=>new Error(reason)});
    let entrySettled=false;
    const first=coordinator.evaluateOnce(entry).then(value=>{entrySettled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(entry.status,'evaluated');
    assert.equal(dependency.status,'evaluated');
    assert.equal(coordinator.evaluationPromises.has(dependency),false,
      'static dependency is evaluated by the entry graph, outside coordinator tracking');
    assert.equal(entrySettled,false,'entry remains blocked on dependency top-level await');
    let dependencySettled=false;
    const second=coordinator.evaluateOnce(dependency).then(value=>{dependencySettled=true;return value;});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(dependencySettled,false,'import must await the native dependency completion promise');
    release(0);
    const [entryModule,dependencyModule]=await Promise.all([first,second]);
    assert.equal(entryModule.namespace.value,84);
    assert.equal(dependencyModule.namespace.value,84);
    process.stdout.write('untracked-static-tla-reconciled');
  `;
  const output=execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','--eval',source],
    {encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
  assert.equal(output,'untracked-static-tla-reconciled');
});
