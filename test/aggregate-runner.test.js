import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CampaignStore} from '../src/corpus/campaign-store.mjs';
import {DEFAULT_AGGREGATE_BUDGET,validateAggregateBudget,parseMountInfo,aggregateSystemdInvocation,
  probeAggregateRunner,runAggregateQuotaCommand} from '../src/corpus/aggregate-runner.mjs';

test('aggregate runner requires every hard budget and builds cgroup-wide limits',()=>{
  const budget=validateAggregateBudget(DEFAULT_AGGREGATE_BUDGET);
  assert.throws(()=>validateAggregateBudget({...budget,pids:null}),/pids/);
  const {workspaceBytes,...missing}=budget;assert.throws(()=>validateAggregateBudget(missing),/exact aggregate/);
  const call=aggregateSystemdInvocation({workspace:'/var/lib/campaign-quota',budget,manager:'user',
    unit:'semantic-campaign-abcd-1234',requestFile:'/var/lib/campaign-quota/request.json'});
  for(const setting of ['KillMode=control-group','OOMPolicy=kill','MemorySwapMax=0','ProtectSystem=strict',
    'ReadOnlyPaths=/dev','RestrictAddressFamilies=AF_INET AF_INET6'])
    assert(call.properties.includes(setting),setting);
  assert(call.properties.some(property=>property.startsWith('MemoryMax=')));
  assert(call.properties.some(property=>property.startsWith('TasksMax=')));
  assert(call.properties.some(property=>property.startsWith('CPUQuota=')));
  assert(call.properties.some(property=>property.startsWith('TemporaryFileSystem=/tmp:')));
  assert.throws(()=>aggregateSystemdInvocation({workspace:'/path/%n',budget,unit:'semantic-campaign-abcd',requestFile:'/tmp/request'}),/Unsafe/);
});

test('mount parsing retains read-only boundaries and escaped mount paths',()=>{
  const mounts=parseMountInfo('24 1 0:20 / / ro,nosuid - overlay overlay ro\n25 24 0:21 / /work\\040space rw,nosuid - tmpfs tmpfs rw,size=4096k\n');
  assert.equal(mounts[0].options.includes('ro'),true);
  assert.equal(mounts[1].point,'/work space');assert.equal(mounts[1].type,'tmpfs');
});

test('unqualified storage fails closed before launch and leaves a durable campaign prefix untouched',async t=>{
  const workspace=mkdtempSync(join(tmpdir(),'aggregate-refusal-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));
  const identity={purpose:'aggregate-fail-closed-test'},store=new CampaignStore(join(workspace,'campaign'),identity);
  store.record('complete',{source:'test'},{status:'unsupported',reason:'retained attempt'});store.close();
  const log=join(workspace,'campaign','campaign.jsonl'),before=readFileSync(log);
  const preflight=probeAggregateRunner({workspace});
  assert.equal(preflight.status,'unavailable');
  assert(preflight.blockers.some(reason=>reason.includes('dedicated')));
  const sentinel=join(workspace,'should-not-exist');
  const result=await runAggregateQuotaCommand({workspace,command:process.execPath,
    args:['-e','require("node:fs").writeFileSync(process.argv[1],"unsafe launch")',sentinel]});
  assert.equal(result.status,'unavailable');assert.equal(result.workloadStarted,false);
  assert.equal(existsSync(sentinel),false);assert.deepEqual(readFileSync(log),before);
  const restored=new CampaignStore(join(workspace,'campaign'),identity,{resume:true});
  assert.equal(restored.entries.length,1);restored.close();
});
