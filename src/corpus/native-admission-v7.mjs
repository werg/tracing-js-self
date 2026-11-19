import {loadNativeSettings,createNativeConsumer} from './native-admission-client.mjs';
import {validateV7NativePolicy} from '../semantic/native-v7.js';

export function loadNativeV7Settings(options){
  const settings=loadNativeSettings(options);
  if(!settings)throw new Error('V7 admission requires the exact independent native checkout and tokenizer');
  validateV7NativePolicy(settings.policy);
  return settings;
}

export function createNativeV7Consumer(settings,{maxPositions=8192,maxHistory=1024}={}){
  validateV7NativePolicy(settings.policy);
  if(!Number.isSafeInteger(maxPositions)||maxPositions<1||!Number.isSafeInteger(maxHistory)||maxHistory<1)
    throw new Error('V7 native geometry must use positive integer budgets');
  return createNativeConsumer(settings,{script:'scripts/admit_semantic_v7.py',extraArguments:[
    '--consumer-revision',settings.policy.consumerRevision,'--max-positions',String(maxPositions),
    '--max-history',String(maxHistory)]});
}
