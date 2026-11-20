#!/usr/bin/env node
// One bounded variant per disposable process. Original-source provenance is
// checked again inside the process; this is not a native fallback for the VM.
import {readFileSync} from 'node:fs';
import {executeOfficialTest262Variant} from '../src/conformance/test262-runner.js';
import {executeOfficialTest262Reference} from '../src/conformance/test262-reference.js';
import {verifyTest262ImplementationFiles} from '../src/conformance/test262-campaign.js';
let request;
try{
  request=JSON.parse(readFileSync(0,'utf8'));
  verifyTest262ImplementationFiles(request.implementation);
  if(!['owned','reference'].includes(request.authority))throw new TypeError('Unknown Test262 execution authority');
  const execute=request.authority==='owned'?executeOfficialTest262Variant:executeOfficialTest262Reference;
  process.stdout.write(JSON.stringify(execute(request.options))+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({status:'infrastructure_error',reason:error.message,phase:'worker',
    caseId:request?.options?.variant?.id??null,executionPerformed:false})+'\n');
  process.exitCode=1;
}
