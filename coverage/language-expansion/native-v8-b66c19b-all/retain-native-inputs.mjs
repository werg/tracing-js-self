import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2]);
const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [filename, digest] of Object.entries(report.artifacts)) {
  assert.equal(sha256(fs.readFileSync(path.join(root, filename))), digest, filename + ' retained bytes');
}
const rows = [];
for (const row of report.rows) {
  if (!row.nativeReceipt?.sourceVerification) continue;
  const sourceBytes = fs.readFileSync(path.join(root, row.sourceArtifact));
  assert.equal(sha256(sourceBytes), report.artifacts[row.sourceArtifact], row.id + ' source bytes');
  const source = JSON.parse(sourceBytes);
  // The qualifier writes pretty retained source documents, but the real native
  // subprocess receives JSON.stringify(source) plus one newline. Reconstruct
  // those exact bytes and check the live source verifier's retained digest.
  const inputBytes = JSON.stringify(source) + '\n';
  const inputSha256 = sha256(inputBytes);
  const verified = row.nativeReceipt.sourceVerification;
  assert.equal(verified.producerRevision, report.producerRevision, row.id + ' producer revision');
  assert.equal(row.nativeReceipt.consumerRevision, report.nativePolicy.consumerRevision,
    row.id + ' consumer revision');
  assert.equal(row.nativeReceipt.tokenizer.sha256, report.nativePolicy.tokenizerSha256,
    row.id + ' production tokenizer');
  assert.equal(inputSha256, verified.artifactSha256, row.id + ' native input');
  const nativeInput = row.id + '.native-input.json';
  fs.writeFileSync(path.join(root, nativeInput), inputBytes);
  rows.push({id: row.id, sourceArtifact: row.sourceArtifact, nativeInput,
    nativeInputSha256: inputSha256, sourceVerification: verified});
}
const manifest = {schema: 'semantic-retained-native-inputs/1',
  inputEncoding: 'Exact JSON.stringify(source) plus newline, reconstructed and checked against live source receipt SHA256',
  producerRevision: report.producerRevision,
  consumerRevision: report.nativePolicy.consumerRevision,
  declared: report.declared, sourceQualified: report.sourceQualified,
  nativeAdmitted: report.nativeAdmitted,
  retainedNativeInputs: rows.length, rows};
fs.writeFileSync(path.join(root, 'native-inputs-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({root, retainedNativeInputs: rows.length,
  declared: report.declared, sourceQualified: report.sourceQualified, nativeAdmitted: report.nativeAdmitted}));
