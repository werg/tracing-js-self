// The native reference may evaluate source outside the owned frontend. The
// optional Linux profile confines that entire process, including vm escapes.
import {mkdtempSync,realpathSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=fileURLToPath(new URL('../../',import.meta.url));
const launcher=fileURLToPath(new URL('../../tools/linux-reference-sandbox.py',import.meta.url));
export function referenceIsolationMode(){
  const mode=process.env.TRACING_REFERENCE_ISOLATION??'trusted-process';
  if(!['trusted-process','linux-namespace'].includes(mode))throw new Error('Unknown reference isolation mode');
  return mode;
}
export function referenceIsolationIdentity(){
  const mode=referenceIsolationMode();
  return {schema:'semantic-reference-isolation/1',mode,
    launcherSha256:createHash('sha256').update(readFileSync(launcher)).digest('hex'),
    ...(mode==='linux-namespace'?{profile:'linux-namespace/1',network:'new-network-namespace-and-denied-socket-syscalls',
      filesystem:'read-only-code-and-runtime-with-private-tmpfs',capabilities:'none',childProcesses:'denied',
      addressSpaceBytes:1024**3,heapMb:256,temporaryBytes:64*1024**2,openFiles:64,jit:'disabled'}:{})};
}
export function referenceEnvironment(){
  return Object.fromEntries(['PATH','TMPDIR','TEMP','TMP','LANG','LC_ALL','TZ'].filter(key=>process.env[key]!=null)
    .map(key=>[key,process.env[key]]));
}
export function referenceCommand(worker,{timeoutMs,isolation=referenceIsolationMode()}={}){
  const env=referenceEnvironment();
  if(isolation==='trusted-process')return {command:process.execPath,args:[worker],env,cleanup(){}};
  if(isolation!=='linux-namespace'||process.platform!=='linux')throw new Error('Linux namespace reference isolation is unavailable');
  const directory=process.env.TMPDIR??tmpdir();mkdirSync(directory,{recursive:true});
  const sandbox=mkdtempSync(join(directory,'semantic-reference-'));
  return {command:'/usr/bin/unshare',args:['--user','--map-root-user','--mount','--net','--ipc','--uts','--pid',
    '--fork','--kill-child=KILL','python3','-I','-S',launcher,'--root',sandbox,'--repo',root,
    '--node',realpathSync(process.execPath),'--worker',realpathSync(worker),
    '--cpu-seconds',String(Math.max(1,Math.ceil(timeoutMs/1000))),
    '--timezone',process.env.TZ??Intl.DateTimeFormat().resolvedOptions().timeZone,
    '--lang',process.env.LANG??'C.UTF-8','--locale',process.env.LC_ALL??process.env.LANG??'C.UTF-8'],env,
    cleanup(){rmSync(sandbox,{recursive:true,force:true});}};
}
