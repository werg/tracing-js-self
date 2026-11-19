// Private, inspectable correspondence. Receipts are integrity evidence, not a
// substitute for independent source checking or a public computation claim.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {algorithmDigest,stableAlgorithmJSON,assertAlgorithmFields} from './ir.js';

export const TRANSFORMATION_RECEIPT_VERSION='semantic-transformation-receipt/1';
const digest=value=>createHash('sha256').update(value).digest('hex');
const hashPattern=/^[0-9a-f]{64}$/;

export function createTransformationReceipt({rule,version=1,source,input,output,sourceSites=[],journalEvents=[],
  preconditions=[],liveInputs=[],liveOutputs=[],effectBoundaries=[]}){
  if(typeof source!=='string')throw new TypeError('Exact source bytes required for transformation receipt');
  const receipt={schema:TRANSFORMATION_RECEIPT_VERSION,rule,version,sourceDigest:digest(source),
    inputDigest:algorithmDigest(input),outputDigest:algorithmDigest(output),
    sourceSites:structuredClone(sourceSites),journalEvents:[...journalEvents],
    preconditions:structuredClone(preconditions),liveInputs:[...liveInputs],liveOutputs:[...liveOutputs],
    effectBoundaries:structuredClone(effectBoundaries)};
  validateTransformationReceipt(receipt);return receipt;
}
export function validateTransformationReceipt(receipt){
  assertAlgorithmFields(receipt,['schema','rule','version','sourceDigest','inputDigest','outputDigest',
    'sourceSites','journalEvents','preconditions','liveInputs','liveOutputs','effectBoundaries'],'transformation receipt');
  if(receipt.schema!==TRANSFORMATION_RECEIPT_VERSION||typeof receipt.rule!=='string'||!receipt.rule||
    !Number.isSafeInteger(receipt.version)||receipt.version<1||
    !['sourceDigest','inputDigest','outputDigest'].every(key=>hashPattern.test(receipt[key]))||
    !['sourceSites','journalEvents','preconditions','liveInputs','liveOutputs','effectBoundaries']
      .every(key=>Array.isArray(receipt[key])))throw new TypeError('Invalid transformation receipt');
  for(const site of receipt.sourceSites){
    assertAlgorithmFields(site,['start','end'],'source correspondence');
    if(!Number.isSafeInteger(site.start)||site.start<0||!Number.isSafeInteger(site.end)||site.end<=site.start)
      throw new TypeError('Invalid transformation source span');
  }
  for(const key of ['journalEvents','liveInputs','liveOutputs'])
    if(receipt[key].some(value=>typeof value!=='string'||!value)||new Set(receipt[key]).size!==receipt[key].length)
      throw new TypeError('Invalid transformation '+key);
  stableAlgorithmJSON(receipt);return true;
}
export function verifyTransformationReceipt(receipt,{source,input,output,rule=receipt?.rule,
  version=receipt?.version,sourceSites=receipt?.sourceSites,journalEvents=receipt?.journalEvents,
  preconditions=receipt?.preconditions,liveInputs=receipt?.liveInputs,liveOutputs=receipt?.liveOutputs,
  effectBoundaries=receipt?.effectBoundaries}={}){
  try{
    validateTransformationReceipt(receipt);
    const expected=createTransformationReceipt({source,input,output,rule,version,sourceSites,journalEvents,
      preconditions,liveInputs,liveOutputs,effectBoundaries});
    return isDeepStrictEqual(receipt,expected);
  }catch{return false;}
}
export function transformationReceiptDigest(receipt){validateTransformationReceipt(receipt);
  return digest(stableAlgorithmJSON(receipt));}
