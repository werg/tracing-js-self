import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';

const root=dirname(fileURLToPath(import.meta.url));
const runner=join(root,'..','tools','qualify-ordinary-v8-lifecycle.mjs');

function invoke(extra){
  return spawnSync(process.execPath,[runner,'--out','/tmp/support-lifecycle-out',
    '--megatoken','/tmp/megatoken','--python','python','--tokenizer','/tmp/tokenizer.json',...extra],
    {encoding:'utf8'});
}

const complete=['--prepared-root','/tmp/prepared','--source-inventory','/tmp/inventory.json',
  '--sample-source','/tmp/sample.json'];
{
  const result=invoke(['--prepared-root','/tmp/prepared']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/requires --source-inventory and --sample-source/);
}
{
  const result=invoke(['--source-inventory','/tmp/inventory.json','--sample-source','/tmp/sample.json']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/require --prepared-root/);
}
{
  const result=invoke([...complete,'--source-id','synthetic']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/selects its source only from the admitted source artifact/);
}
{
  const result=invoke([...complete,'--orchestration-teacher']);
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/do not attach a second teacher/);
}

{
  const result=spawnSync(process.execPath,[runner,'--out','/tmp/prepared/nested-output',
    '--megatoken','/tmp/megatoken','--python','python','--tokenizer','/tmp/tokenizer.json',
    ...complete],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/outside both pinned checkouts/);
}
