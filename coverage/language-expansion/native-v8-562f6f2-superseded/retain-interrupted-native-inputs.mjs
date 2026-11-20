import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';

const [directory,producerRevision,consumerRevision]=process.argv.slice(2);
assert(directory&&producerRevision&&consumerRevision,'DIRECTORY PRODUCER_SHA CONSUMER_SHA');
const root=resolve(directory),target=join(root,'interrupted-native-inputs');
assert(!existsSync(target),'Historical input destination must be new');mkdirSync(target);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const attemptsBytes=readFileSync(join(root,'attempts.jsonl'));
const attempts=attemptsBytes.toString().split('\n').filter(Boolean).map(row=>JSON.parse(row)),rows=[];
for(const row of attempts){
  if(row.native!=='passed')continue;
  const receipt=JSON.parse(readFileSync(join(root,row.id+'.native.json')));
  assert.deepEqual(receipt,row.nativeReceipt);
  assert.equal(receipt.consumerRevision,consumerRevision);
  assert.equal(receipt.sourceVerification.producerRevision,producerRevision);
  const sourceBytes=readFileSync(join(root,row.sourceArtifact));
  const inputBytes=JSON.stringify(JSON.parse(sourceBytes))+'\n',digest=sha(inputBytes);
  assert.equal(digest,receipt.sourceVerification.artifactSha256);
  const name=row.id+'.native-input.json';writeFileSync(join(target,name),inputBytes,{flag:'wx'});
  rows.push({id:row.id,sourceArtifact:row.sourceArtifact,sourceArtifactSha256:sha(sourceBytes),nativeInput:name,nativeInputSha256:digest});
}
const manifest={schema:'semantic-v8-interrupted-native-inputs/1',producerRevision,consumerRevision,
  attemptsSha256:sha(attemptsBytes),recordedAttempts:attempts.length,retainedNativeInputs:rows.length,
  freshNativeExecution:false,scope:'Exact transport bytes reconstructed only for committed successful attempts and verified against their live source receipt digests; this does not complete the interrupted population.',rows};
writeFileSync(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({root,recordedAttempts:attempts.length,retainedNativeInputs:rows.length}));
