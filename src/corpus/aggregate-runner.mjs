// Linux aggregate runner for reviewed, pinned workloads. Configuration alone
// is not qualification: the in-unit child reads the actual kernel boundaries
// before spawning a workload. No monitoring-only fallback is permitted.
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync,realpathSync,statfsSync,createWriteStream,writeFileSync,existsSync} from 'node:fs';
import {finished} from 'node:stream/promises';
import {release} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {generationEnvironment} from './generation-process.mjs';

const ensure=(value,message)=>{if(!value)throw new Error(message);};
const MiB=1024**2;
const child=fileURLToPath(new URL('../../tools/aggregate-runner-child.mjs',import.meta.url));
export const AGGREGATE_READY='AGGREGATE_RUNNER_READY ';
export const DEFAULT_AGGREGATE_BUDGET=Object.freeze({cpus:2,memoryBytes:2*1024**3,pids:128,
  workspaceBytes:512*MiB,temporaryBytes:64*MiB,wallTimeMs:3600000});
export function validateAggregateBudget(budget){
  ensure(budget&&Object.keys(budget).sort().join(',')==='cpus,memoryBytes,pids,temporaryBytes,wallTimeMs,workspaceBytes',
    'An exact aggregate CPU/memory/PID/workspace/temporary/wall-time budget is required');
  ensure(Number.isFinite(budget.cpus)&&budget.cpus>=0.1&&budget.cpus<=256,'Invalid aggregate CPU quota');
  for(const [key,min,max] of [['memoryBytes',64*MiB,16*1024**4],['pids',16,65536],
    ['workspaceBytes',4*MiB,16*1024**4],['temporaryBytes',MiB,1024**3],['wallTimeMs',1000,86400000]])
    ensure(Number.isSafeInteger(budget[key])&&budget[key]>=min&&budget[key]<=max,'Invalid aggregate '+key);
  return {...budget};
}

const unescapeMount=value=>value.replace(/\\(040|011|012|134)/g,(_,octal)=>String.fromCharCode(parseInt(octal,8)));
export function parseMountInfo(text){
  return text.trim().split('\n').filter(Boolean).map(line=>{
    const [left,right]=line.split(' - ');ensure(right,'Malformed Linux mountinfo');
    const fields=left.split(' '),filesystem=right.split(' ');
    return {id:Number(fields[0]),root:unescapeMount(fields[3]),point:unescapeMount(fields[4]),
      options:fields[5].split(','),type:filesystem[0],source:unescapeMount(filesystem[1]),
      superOptions:filesystem[2].split(',')};
  });
}
const inside=(path,parent)=>path===parent||path.startsWith(parent+'/');
function mountAt(mounts,path){return mounts.filter(mount=>inside(path,mount.point)||mount.point==='/')
  .sort((a,b)=>b.point.length-a.point.length||b.id-a.id)[0];}
function cappedFilesystem(path,maximum,mounts){
  const actual=realpathSync(path),mount=mountAt(mounts,actual),stat=statfsSync(actual,{bigint:true});
  ensure(actual===resolve(path)&&mount?.point===actual&&mount.type==='tmpfs'&&mount.options.includes('rw'),
    'Writable workspace must be an existing dedicated, canonical tmpfs mount');
  const bytes=stat.bsize*stat.blocks;
  ensure(bytes>0n&&bytes<=BigInt(maximum),'Dedicated filesystem exceeds the hard byte budget');
  return {path:actual,type:mount.type,capacityBytes:Number(bytes),availableBytes:Number(stat.bsize*stat.bavail)};
}

export function probeAggregateRunner({workspace,budget=DEFAULT_AGGREGATE_BUDGET,manager='user'}={}){
  budget=validateAggregateBudget(budget);
  ensure(['user','system'].includes(manager),'Unknown systemd manager');
  const blockers=[],checks={platform:process.platform,systemdManager:manager,cgroupV2:false,workspace:null};
  if(process.platform!=='linux')blockers.push('Linux cgroup v2 is required');
  let mounts=[];
  try{
    mounts=parseMountInfo(readFileSync('/proc/self/mountinfo','utf8'));
    checks.cgroupV2=mounts.some(row=>row.type==='cgroup2');
    if(!checks.cgroupV2)blockers.push('No cgroup-v2 filesystem is exposed to this runner');
  }catch(error){blockers.push('Cannot inspect Linux mounts: '+error.message);}
  try{
    ensure(typeof workspace==='string'&&/^\/[A-Za-z0-9/_.,@+-]+$/.test(workspace)&&workspace!=='/',
      'An explicit canonical workspace mount without systemd path specifiers is required');
    checks.workspace=cappedFilesystem(workspace,budget.workspaceBytes,mounts);
  }catch(error){blockers.push(error.message);}
  try{
    const args=[...(manager==='user'?['--user']:[]),'show','--property=Version','--value'];
    checks.systemdVersion=execFileSync('systemctl',args,{encoding:'utf8',timeout:5000,
      stdio:['ignore','pipe','pipe'],maxBuffer:65536}).trim();
    ensure(checks.systemdVersion,'Service manager did not identify itself');
  }catch(error){blockers.push('Systemd manager unavailable: '+String(error.stderr??error.message).trim().slice(0,500));}
  return {schema:'aggregate-runner-preflight/1',status:blockers.length?'unavailable':'prerequisites-available',
    observedAt:new Date().toISOString(),runtime:{node:process.version,v8:process.versions.v8,kernel:release()},
    budget,checks,blockers,workloadStarted:false,containerDigest:null,
    qualification:'unqualified-until-in-unit-kernel-boundary-check',
    boundary:'Per-worker V8 limits and RSS polling never substitute for aggregate kernel enforcement.'};
}

export function aggregateSystemdInvocation({workspace,budget,manager='user',unit,requestFile}){
  validateAggregateBudget(budget);
  ensure(/^semantic-campaign-[a-f0-9-]+$/.test(unit),'Invalid aggregate unit identity');
  ensure(/^\/[A-Za-z0-9/_.,@+-]+$/.test(workspace)&&/^\/[A-Za-z0-9/_.,@+-]+$/.test(requestFile),
    'Unsafe systemd workspace/request path');
  ensure(['user','system'].includes(manager),'Unknown systemd manager');
  const properties=[
    'CPUAccounting=yes','MemoryAccounting=yes','TasksAccounting=yes',
    'CPUQuota='+(budget.cpus*100)+'%','CPUQuotaPeriodSec=100ms',
    'MemoryMax='+budget.memoryBytes,'MemorySwapMax=0','TasksMax='+budget.pids,
    'RuntimeMaxSec='+Math.ceil(budget.wallTimeMs/1000)+'s','KillMode=control-group',
    'OOMPolicy=kill','SendSIGKILL=yes','TimeoutStopSec=5s',
    'ProtectSystem=strict','ProtectHome=read-only','ReadWritePaths='+workspace,
    'TemporaryFileSystem=/tmp:rw,nodev,nosuid,size='+budget.temporaryBytes+',mode=1777',
    'ReadOnlyPaths=/dev','InaccessiblePaths=-/dev/shm -/dev/mqueue -/run/dbus/system_bus_socket -/run/systemd/private',
    'ProtectControlGroups=yes','ProtectKernelTunables=yes','PrivateDevices=yes','PrivateMounts=yes',
    'NoNewPrivileges=yes','CapabilityBoundingSet=','AmbientCapabilities=','RestrictNamespaces=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6','RestrictSUIDSGID=yes',
    ...(manager==='user'?['PrivateUsers=yes']:[])
  ];
  return {command:'systemd-run',args:[...(manager==='user'?['--user']:[]),'--wait','--pipe','--quiet',
    '--unit='+unit,'--working-directory='+workspace,...properties.map(value=>'--property='+value),
    '--',process.execPath,child,requestFile],properties};
}

export function verifyAggregateKernelBoundary({workspace,budget}){
  budget=validateAggregateBudget(budget);
  const mounts=parseMountInfo(readFileSync('/proc/self/mountinfo','utf8'));
  const cgroupMount=mounts.find(row=>row.type==='cgroup2');
  ensure(cgroupMount&&cgroupMount.options.includes('ro'),'The workload must see a read-only cgroup-v2 hierarchy');
  const membership=readFileSync('/proc/self/cgroup','utf8').split('\n').find(row=>row.startsWith('0::'))?.slice(3);
  ensure(typeof membership==='string'&&membership.startsWith('/')&&!membership.split('/').includes('..'),
    'Missing unified cgroup membership');
  const relative=cgroupMount.root==='/'?membership:inside(membership,cgroupMount.root)?membership.slice(cgroupMount.root.length):null;
  ensure(relative!==null,'Cgroup membership is outside its mounted hierarchy');
  const directory=join(cgroupMount.point,relative);
  const read=name=>readFileSync(join(directory,name),'utf8').trim();
  const finiteLimit=(name,limit)=>{
    const actual=read(name);ensure(/^\d+$/.test(actual)&&BigInt(actual)<=BigInt(limit),name+' is not hard bounded as requested');
    return Number(actual);
  };
  const memoryBytes=finiteLimit('memory.max',budget.memoryBytes),swapBytes=finiteLimit('memory.swap.max',0),pids=finiteLimit('pids.max',budget.pids);
  ensure(read('memory.oom.group')==='1','Memory exhaustion must terminate the entire workload cgroup');
  const cpu=read('cpu.max').split(/\s+/);
  ensure(cpu.length===2&&cpu.every(value=>/^\d+$/.test(value))&&Number(cpu[1])>0&&
    Number(cpu[0])/Number(cpu[1])<=budget.cpus+1e-8,'cpu.max is not hard bounded as requested');
  if(existsSync(join(directory,'cpu.max.burst')))ensure(read('cpu.max.burst')==='0','CPU burst exceeds the declared rate budget');
  const output=cappedFilesystem(workspace,budget.workspaceBytes,mounts);
  const temporary=cappedFilesystem('/tmp',budget.temporaryBytes,mounts);
  const writable=mounts.filter(mount=>mount.options.includes('rw')&&
    !['proc','devpts'].includes(mount.type)&&mount.point!==output.path&&mount.point!=='/tmp');
  ensure(writable.length===0,'Additional writable filesystems would evade the aggregate disk boundary: '+writable.map(row=>row.point).join(', '));
  const status=readFileSync('/proc/self/status','utf8');
  ensure(/^NoNewPrivs:\s+1$/m.test(status)&&/^CapEff:\s+0+$/m.test(status),
    'Workload must run without effective capabilities or privilege escalation');
  return {schema:'aggregate-kernel-boundary/1',status:'verified',cgroup:membership,
    limits:{cpuQuota:Number(cpu[0]),cpuPeriod:Number(cpu[1]),memoryBytes,swapBytes,pids,
      workspaceBytes:output.capacityBytes,temporaryBytes:temporary.capacityBytes},
    writableFilesystems:[output,temporary],containerDigest:null,
    scope:'Kernel aggregate limits and current mount boundaries read back before launch; runtime-image and exhaustion qualification remain separate.'};
}

export async function runAggregateQuotaCommand({workspace,budget=DEFAULT_AGGREGATE_BUDGET,
    manager='user',command,args=[],signal}={}){
  ensure(typeof command==='string'&&command.length>0&&Array.isArray(args)&&args.every(arg=>typeof arg==='string'),
    'Explicit command and argument array are required');
  const preflight=probeAggregateRunner({workspace,budget,manager});
  if(preflight.status!=='prerequisites-available')return {status:'unavailable',workloadStarted:false,preflight};
  if(signal?.aborted)return {status:'cancelled',workloadStarted:false,preflight};
  const nonce=randomUUID(),unit='semantic-campaign-'+nonce,requestFile=join(workspace,'.aggregate-'+nonce+'.json');
  const request={schema:'aggregate-runner-request/1',nonce,workspace,budget,command,args,
    environment:{...generationEnvironment(),TMPDIR:'/tmp',TMP:'/tmp',TEMP:'/tmp'}};
  writeFileSync(requestFile,JSON.stringify(request)+'\n',{mode:0o600,flag:'wx'});
  const invocation=aggregateSystemdInvocation({workspace,budget,manager,unit,requestFile});
  const logs={stdout:join(workspace,'aggregate-'+nonce+'.stdout.log'),stderr:join(workspace,'aggregate-'+nonce+'.stderr.log')};
  return new Promise(resolveRun=>{
    const output=createWriteStream(logs.stdout,{flags:'wx',mode:0o600}),errors=createWriteStream(logs.stderr,{flags:'wx',mode:0o600});
    const service=spawn(invocation.command,invocation.args,{stdio:['ignore','pipe','pipe'],shell:false});
    let ready=null,line='',problem=null,closed=false,cancelled=false;
    const controlArgs=[...(manager==='user'?['--user']:[])];
    const stop=()=>{
      const stopper=spawn('systemctl',[...controlArgs,'kill','--kill-whom=all','--signal=SIGKILL',unit],{stdio:'ignore',shell:false});
      stopper.on('error',()=>{});
    };
    const abort=()=>{cancelled=true;stop();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{problem='Aggregate supervisor deadline exceeded';stop();},budget.wallTimeMs+10000);
    const logError=error=>{problem='Quota workspace log write failed: '+error.message;stop();service.stdout.resume();service.stderr.resume();};
    output.on('error',logError);errors.on('error',logError);
    function forward(stream,destination){
      stream.on('data',bytes=>{
        if(destination.destroyed)return;
        if(!destination.write(bytes))stream.pause();
      });destination.on('drain',()=>stream.resume());
    }
    service.stdout.on('data',bytes=>{
      if(ready||problem)return;
      line+=bytes.toString('utf8');
      const end=line.indexOf('\n');
      if(end>=0){
        const marker=AGGREGATE_READY+nonce+' ';
        if(!line.startsWith(marker)){problem='Child did not verify aggregate kernel limits before output';stop();return;}
        try{ready=JSON.parse(line.slice(marker.length,end));ensure(ready.status==='verified','Invalid child boundary receipt');
          if(cancelled)stop();}
        catch(error){problem=error.message;stop();}
        line='';
      }else if(line.length>65536){problem='Aggregate readiness protocol exceeded its bound';stop();}
    });
    forward(service.stdout,output);forward(service.stderr,errors);
    service.once('error',error=>{problem=error.message;});
    service.once('close',async(code,exitSignal)=>{
      if(closed)return;closed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      output.end();errors.end();
      await Promise.allSettled([finished(output),finished(errors)]);
      let unitProperties=null;
      try{unitProperties=execFileSync('systemctl',[...controlArgs,'show',unit,
        '--property=Result,ExecMainStatus,CPUUsageNSec,MemoryPeak,TasksCurrent,ControlGroup'],
        {encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe'],maxBuffer:65536}).trim();}catch{}
      const cleanup=spawn('systemctl',[...controlArgs,'reset-failed',unit],{stdio:'ignore',shell:false});cleanup.on('error',()=>{});
      resolveRun({schema:'aggregate-runner-result/1',status:cancelled?'cancelled':code===0&&ready&&!problem?'completed':ready?'failed':'refused',
        workloadStarted:Boolean(ready),code,signal:exitSignal,problem,unit,preflight,kernelBoundary:ready,unitProperties,logs,
        campaignPrefix:'Existing fsynced CampaignStore records remain on the externally mounted workspace; recover a torn final log via normal resume.',
        qualification:'No portable image or kernel-exhaustion qualification is inferred.'});
    });
  });
}
