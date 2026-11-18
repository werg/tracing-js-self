import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=resolve(fileURLToPath(new URL('..',import.meta.url)));
const validator=resolve(repository,'tools/validate-semantic-v6-emission.mjs');

function validate(payload){
  const result=spawnSync(process.execPath,[validator],{input:payload,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}

test('native emission validator uses exact production v6 parsing',()=>{
  const valid=validate('end return');
  assert.equal(valid.status,'valid');
  assert.equal(valid.representation,'semantic-trace/6');
  assert.equal(valid.kind,'end');
  assert.equal(valid.semanticCorrectness,'not-evaluated');

  const malformed=validate('end {"completion":"return"}');
  assert.equal(malformed.status,'invalid');

  const trailingNewline=validate('end return\n');
  assert.equal(trailingNewline.status,'invalid');
});
