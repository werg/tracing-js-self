import {loadNativeSettings,createNativeConsumer} from './native-admission-client.mjs';
import {validateV8NativePolicy,validateV8NativeReceipt} from '../semantic/native-v8.js';

export function loadNativeV8Settings(options){
  const settings=loadNativeSettings(options);
  if(!settings)throw new Error('V8 admission requires the independent native checkout and exact tokenizer');
  validateV8NativePolicy(settings.policy);return settings;
}
export function createNativeV8Consumer(settings){
  validateV8NativePolicy(settings?.policy);
  const invoke=createNativeConsumer(settings,{script:'scripts/admit_semantic_v8.py',extraArguments:[
    '--consumer-revision',settings.policy.consumerRevision]});
  return async exported=>{
    const receipt=await invoke(exported);validateV8NativeReceipt(exported,receipt,settings.policy);return receipt;
  };
}
