import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('browser condition provides a no-Node-import bounded runtime and rejects host objects',()=>{
  // The same condition is selected by browser-targeted ESM bundlers.
  const program=`
    import assert from 'node:assert/strict';
    import * as api from 'tracing-js-self';
    assert.equal(typeof api.createRuntime,'function');
    assert.equal(api.validateBundle,undefined);
    assert.equal(api.executeWithNativeServices,undefined);
    const runtime=api.createRuntime({maxSteps:10000});
    const source=runtime.registerSource({
      text:'"use strict";function twice(x){return x*2;}',trainingProfile:true
    });
    runtime.startEntry({source,functionName:'twice',args:[4]});
    assert.equal(runtime.drive().kind,'terminated');
    const archive=runtime.exportRun();
    assert.equal(archive.sources.length,1);
    assert(archive.events.length>0);
    assert.equal(typeof api.causalPrefix(archive),'object');
    assert.throws(()=>api.createRuntime({adapters:{}}),/Unsupported browser runtime option/);
    assert.throws(()=>{runtime.adapters={};},TypeError);
    assert.equal(Object.isFrozen(runtime.adapters),true);
    const next=api.createRuntime();
    const nextSource=next.registerSource({
      text:'"use strict";function read(x){return x.value;}',trainingProfile:true
    });
    assert.throws(()=>next.startEntry({
      source:nextSource,functionName:'read',args:[{value:9}]
    }),/Browser host object inputs are unavailable/);
  `;
  const run=spawnSync(process.execPath,['--conditions=browser','--input-type=module','-e',program],{
    encoding:'utf8',cwd:process.cwd(),timeout:20000
  });
  assert.equal(run.status,0,run.stderr||run.error?.message);
});
