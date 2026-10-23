import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// VM modules are behind a Node flag. Keep normal npm test unflagged and run
// focused native-module diagnostics in a separate process with that flag.
test('pinned Test262 native module reference regressions',()=>{
 const driver=fileURLToPath(new URL('./fixtures/test262-module-reference.mjs',import.meta.url));
 const result=spawnSync(process.execPath,
   ['--no-warnings','--experimental-vm-modules','--test',driver],
   {encoding:'utf8',timeout:15000,env:Object.fromEntries(
     Object.entries(process.env).filter(([key])=>!key.startsWith('NODE_TEST')))});
 assert.equal(result.status,0,String(result.error??'')+'\n'+result.stdout+'\n'+result.stderr);
 assert.match(result.stdout,/pass 7/);
 assert.match(result.stdout,/fail 0/);
});
