// Acquire exact local Git blobs. No network fetch, source execution, or implicit
// checkout update occurs here. A changed working file fails its pinned blob check.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync} from 'node:fs';
import {join,resolve,posix} from 'node:path';
import {parse} from 'acorn';
import {gitBlobSha} from '../test262-baseline.js';
import {safeTest262Path,parseTest262Header,test262VariantModes,validateTest262Catalog,conformanceDigest} from './test262-catalog.js';

export function acquireTest262GitSnapshot({suiteRoot,revision}={}){
  if(typeof suiteRoot!=='string'||revision!==undefined&&!/^[a-f0-9]{40}$/.test(revision))
    throw new TypeError('Test262 acquisition requires a local Git root and an optional exact commit');
  const root=resolve(suiteRoot);
  const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:64*1024*1024});
  const head=git(['rev-parse','HEAD']).trim();
  revision??=head;
  if(head!==revision)throw new TypeError('Test262 checkout HEAD differs from the requested exact revision');
  const treeSha=git(['rev-parse',revision+'^{tree}']).trim();
  const entries=git(['ls-tree','-r','-z',revision,'--','test','harness']).split('\0').filter(Boolean);
  const files={},sources={};
  for(const entry of entries){
    const match=/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if(!match||!['100644','100755'].includes(match[1])||!safeTest262Path(match[3]))
      throw new TypeError('Unsupported Test262 tree entry: '+entry);
    const [, ,blob,path]=match,absolute=join(root,path);
    // Every path component is checked to avoid reading through untracked links.
    let current=root;
    for(const component of path.split('/')){
      current=join(current,component);
      if(lstatSync(current).isSymbolicLink())throw new TypeError('Test262 checkout contains a symbolic link: '+path);
    }
    const bytes=readFileSync(absolute);
    if(gitBlobSha(bytes)!==blob)throw new TypeError('Test262 checkout bytes differ from pinned blob: '+path);
    files[path]=blob;sources[path]=bytes;
  }
  if(!Object.keys(files).some(path=>path.startsWith('test/')&&path.endsWith('.js')))
    throw new TypeError('Empty Test262 Git source inventory');
  return {snapshot:{repository:'tc39/test262',revision,files,
    acquisition:{kind:'exact-git-tree',treeSha,fullUpstreamTree:true,scope:['test','harness']}},sources};
}

/** A retained catalog is an observation to reconcile, not authority to omit
 * original modes or relabel their metadata. Recheck every acquired input even
 * when execution selects only a small shard of the population. */
export function verifyTest262AcquiredCatalog({catalog,snapshot,sources}={}){
  validateTest262Catalog(catalog);
  if(catalog.repository!==snapshot.repository||catalog.suiteRevision!==snapshot.revision||
    Object.keys(snapshot.files).length!==catalog.files.length)
    throw new TypeError('Acquired exact Git tree differs from the retained catalog population');
  const variants=new Map();
  for(const row of catalog.variants){
    const rows=variants.get(row.path)??[];rows.push(row);variants.set(row.path,rows);
  }
  for(const file of catalog.files){
    const source=sources[file.path],bytes=typeof source==='string'?Buffer.from(source):source;
    if(!(bytes instanceof Uint8Array)||snapshot.files[file.path]!==file.gitBlobSha||bytes.length!==file.bytes||
      createHash('sha256').update(bytes).digest('hex')!==file.sha256)
      throw new TypeError('Acquired source bytes differ from the retained catalog: '+file.path);
    if(file.kind!=='test')continue;
    let metadata=null;
    try{metadata=parseTest262Header(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{}
    const rows=variants.get(file.path),modes=metadata?test262VariantModes(metadata):['unclassified'];
    if(conformanceDigest(rows.map(row=>row.mode))!==conformanceDigest(modes)||
      rows.some(row=>conformanceDigest(row.metadata)!==conformanceDigest(metadata)))
      throw new TypeError('Retained Test262 variants differ from original source metadata: '+file.path);
  }
  return true;
}

/** Static module requests are extracted by the pinned parser. Unsupported
 * grammar and computed imports remain explicit unresolved closure obligations.
 * The interpreter's module loader, not this inventory, owns resolution semantics. */
export function discoverTest262ModuleDependencies(sources){
  const result={},pending=[];
  const text=path=>typeof sources[path]==='string'?sources[path]:
    new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(sources[path]);
  for(const path of Object.keys(sources).filter(path=>path.startsWith('test/')&&path.endsWith('.js'))){
    if(path.split('/').at(-1).includes('_FIXTURE'))continue;
    try{if(parseTest262Header(text(path)).flags.includes('module'))pending.push(path);}catch{}
  }
  while(pending.length){
    const path=pending.pop();if(Object.hasOwn(result,path))continue;
    const paths=new Set(),unresolved=[];
    let ast;
    try{ast=parse(text(path),{ecmaVersion:'latest',sourceType:'module'});}
    catch(error){result[path]={paths:[],unresolved:['Module parser: '+error.message]};continue;}
    function request(specifier){
      if(typeof specifier!=='string'){unresolved.push('Computed dynamic import requires execution-time resolution');return;}
      if(!specifier.startsWith('./')&&!specifier.startsWith('../')){
        unresolved.push('Non-relative module request: '+specifier);return;
      }
      const target=posix.normalize(posix.join(posix.dirname(path),specifier));
      if(!safeTest262Path(target)||!Object.hasOwn(sources,target)){
        unresolved.push('Missing module request: '+specifier);return;
      }
      paths.add(target);
      if(target.endsWith('.js'))pending.push(target);
      else result[target]={paths:[],unresolved:['Module type requires a declared host loader']};
    }
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)
        request(node.source.value);
      if(node.type==='ImportExpression')request(node.source.type==='Literal'?node.source.value:null);
      for(const child of Object.values(node))if(Array.isArray(child))child.forEach(visit);
      else if(child&&typeof child==='object')visit(child);
    }
    visit(ast);result[path]={paths:[...paths].sort(),unresolved:[...new Set(unresolved)].sort()};
  }
  return result;
}
