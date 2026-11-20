import {loadNativeSettings,createNativeConsumer} from './native-admission-client.mjs';
import {validateV8NativePolicy,validateV8NativeReceipt} from '../semantic/native-v8.js';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function loadNativeV8Settings(options){
  const settings=loadNativeSettings(options);
  if(!settings)throw new Error('V8 admission requires the independent native checkout and exact tokenizer');
  validateV8NativePolicy(settings.policy);
  const producerRoot=fileURLToPath(new URL('../..',import.meta.url));
  const producerRevision=execFileSync('git',['-C',producerRoot,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const producerChanges=execFileSync('git',['-C',producerRoot,'status','--porcelain','--untracked-files=all'],{encoding:'utf8'}).trim();
  if(!/^[a-f0-9]{40}$/.test(producerRevision)||producerChanges)
    throw new Error('Source producer checkout must be at an exact clean revision');
  return {...settings,producerRoot,producerRevision};
}
export function createNativeV8Consumer(settings){
  validateV8NativePolicy(settings?.policy);
  const invoke=createNativeConsumer(settings,{script:'scripts/admit_semantic_v8.py',extraArguments:[
    '--consumer-revision',settings.policy.consumerRevision,
    '--producer-root',settings.producerRoot,'--producer-revision',settings.producerRevision]});
  return async exported=>{
    const receipt=await invoke(exported);
    if(receipt?.sourceVerification?.producerRevision!==settings.producerRevision)
      throw new Error('Native source verification differs from the exact clean producer revision');
    validateV8NativeReceipt(exported,receipt,settings.policy);return receipt;
  };
}
