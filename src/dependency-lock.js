// npm omits package-lock.json from published archives. Its generated copy is
// data provenance for installed execution, never a second dependency manifest.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const PACKAGED_DEPENDENCY_LOCK='contracts/npm-lock.json';

export function readDependencyLock(root=fileURLToPath(new URL('../',import.meta.url))){
  if(root instanceof URL)root=fileURLToPath(root);
  let source;
  try{source=readFileSync(join(root,'package-lock.json'));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const packaged=readFileSync(join(root,PACKAGED_DEPENDENCY_LOCK));
  if(source&&!source.equals(packaged))
    throw new Error('Root dependency lock differs from its packaged evidence; run node tools/generate-dependency-lock.mjs');
  return source??packaged;
}
