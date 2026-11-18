import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const workflow=readFileSync(new URL('../.github/workflows/megatoken-consumer.yml',import.meta.url),'utf8');
const step=workflow.match(/      - name: Package complete rechecked native release and rejection evidence\n        run: \|\n([\s\S]*?)(?=      - name:)/)?.[1];
assert(step,'The actual release workflow step must exist');

function runStep(t,recipe,{failSelector=false}={}){
  const directory=mkdtempSync(join(tmpdir(),'native-ci-selection-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const commands=join(directory,'commands.jsonl'),bin=join(directory,'bin');mkdirSync(bin);
  // Exercise the actual CI shell branch and argument routing. These command
  // recorders do not stand in for semantic/native admission; the separate
  // pinned integration probe retains that real failure and success evidence.
  for(const command of ['node','python'])writeFileSync(join(bin,command),
    '#!'+process.execPath+'\n'+
    'const fs=require("node:fs");const args=process.argv.slice(2);'+
    'fs.appendFileSync(process.env.COMMAND_LOG,JSON.stringify({command:'+JSON.stringify(command)+',args})+"\\n");'+
    'if(process.env.FAIL_SELECTOR==="1"&&args[0]==="tools/select-admitted-campaign.mjs")process.exit(41);\n',
    {mode:0o755});
  const script=step.replace(/^          /gm,'').replaceAll('${{ matrix.recipe }}',recipe);
  const result=spawnSync('bash',['--noprofile','--norc','-e','-o','pipefail','-c',script],{
    encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,
      RUNNER_TEMP:join(directory,'runner with spaces'),COMMAND_LOG:commands,
      FAIL_SELECTOR:failSelector?'1':'0'}});
  const calls=readFileSync(commands,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  return {result,calls,runner:join(directory,'runner with spaces')};
}
function flag(args,name){const index=args.indexOf(name);return index<0?undefined:args[index+1];}

test('real-source CI selects exact public representatives and packages the complete original audit',t=>{
  const {result,calls,runner}=runStep(t,'real-source');
  assert.equal(result.status,0,result.stderr);assert.equal(calls.length,3);
  assert.deepEqual(calls[0],{command:'node',args:['tools/select-admitted-campaign.mjs',
    '--input',join(runner,'corpus'),'--out',join(runner,'selected-corpus'),
    '--deduplicate-exact-public','true','--tracer-root','.']});
  const pack=calls[1].args;
  assert.equal(flag(pack,'--corpus'),join(runner,'selected-corpus'));
  assert.equal(flag(pack,'--audit-campaign'),join(runner,'corpus'));
  assert.equal(flag(pack,'--max-family-tokens'),'10000');
  assert.equal(flag(pack,'--max-family-share'),'0.2');
  assert.deepEqual(calls[2].args,['tools/package-semantic-release.py','--verify',
    join(runner,'release/semantic-v5-release.tar.gz')]);
  assert.match(workflow,/\$\{\{ runner.temp \}\}\/selected-corpus\//);
});

test('other CI recipes preserve their original corpus and strict generated training caps',t=>{
  for(const recipe of ['engineering','training-v4','benchmark-v1','generated-v1']){
    const {result,calls,runner}=runStep(t,recipe);
    assert.equal(result.status,0,result.stderr);assert.equal(calls.length,2);
    const pack=calls[0].args;
    assert.equal(flag(pack,'--corpus'),join(runner,'corpus'));
    assert.equal(flag(pack,'--audit-campaign'),undefined);
    assert.equal(flag(pack,'--max-family-tokens'),recipe==='generated-v1'?'10000':undefined);
    assert.equal(flag(pack,'--max-family-share'),recipe==='generated-v1'?'0.2':undefined);
  }
});

test('a refused representative selection stops CI before packaging',t=>{
  const {result,calls}=runStep(t,'real-source',{failSelector:true});
  assert.equal(result.status,41);assert.equal(calls.length,1);
  assert.equal(calls[0].args[0],'tools/select-admitted-campaign.mjs');
});
