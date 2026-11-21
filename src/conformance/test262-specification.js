// Exact annual ECMA-262 17th edition bytes used to bind new Test262 campaigns.
// The retained HTML itself contains Ecma's complete copyright and license section.
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../..',import.meta.url));
const manifestPath=fileURLToPath(new URL('../../artifacts/conformance/ecma262-17.0.json',import.meta.url));
const expectedManifestSha256='c32d2a0349c7273f8bedcea4dbd0266351adfb938fe6878906f5510e2c1861ac';
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');

function readManifest(){
  const bytes=readFileSync(manifestPath);
  if(sha256(bytes)!==expectedManifestSha256)
    throw new TypeError('Retained ECMA-262 2026 pin metadata changed');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(manifest.edition!=='ECMAScript 2026'||manifest.standard!=='ECMA-262 17th edition, June 2026'||
    manifest.uri!=='https://262.ecma-international.org/17.0/index.html'||
    manifest.normativeFormat!=='text/html'||manifest.artifact!=='artifacts/conformance/ecma262-17.0-index.html.xz'||
    !Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||!/^[a-f0-9]{64}$/.test(manifest.sha256??'')||
    !Number.isSafeInteger(manifest.archiveBytes)||manifest.archiveBytes<1||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256??''))
    throw new TypeError('Invalid retained ECMA-262 2026 pin metadata');
  return manifest;
}

/** Compare actual retained specification bytes with both metadata and campaign identity. */
export function verifyEcma262SpecificationBytes(bytes,specification,manifest=readManifest()){
  if(!(bytes instanceof Uint8Array)||!specification||typeof specification!=='object'||
    specification.uri!==manifest.uri||specification.sha256!==manifest.sha256||
    specification.bytes!==undefined&&specification.bytes!==manifest.bytes||
    bytes.byteLength!==manifest.bytes||sha256(bytes)!==manifest.sha256)
    throw new TypeError('ECMA-262 2026 specification bytes differ from the declared identity');
  return true;
}

/** Read and verify the retained official normative HTML bytes before a new campaign. */
export function readPinnedEcma262Specification({declared}={}){
  const manifest=readManifest();
  const archivePath=resolve(root,manifest.artifact);
  if(!lstatSync(archivePath).isFile())throw new TypeError('Retained ECMA-262 2026 artifact must be a regular file');
  const archive=readFileSync(archivePath);
  if(archive.byteLength!==manifest.archiveBytes||sha256(archive)!==manifest.archiveSha256)
    throw new TypeError('Retained ECMA-262 2026 archive differs from its acquisition identity');
  const bytes=execFileSync('xz',['--decompress','--stdout','--',archivePath],{maxBuffer:manifest.bytes+1});
  const specification={uri:manifest.uri,sha256:manifest.sha256,bytes:manifest.bytes};
  verifyEcma262SpecificationBytes(bytes,specification,manifest);
  if(declared!==undefined)verifyEcma262SpecificationBytes(bytes,declared,manifest);
  return {manifest,specification,bytes};
}

/** A historical unpinned report remains inspectable; any declared pin is verified against bytes. */
export function verifyDeclaredEcma262Specification(specification){
  if(specification===null)return true;
  const pinned=readPinnedEcma262Specification({declared:specification});
  return pinned.specification;
}
