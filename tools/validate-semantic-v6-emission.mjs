// Validate one exact native decoder emission with the production v6 parser.
import {createHash} from 'node:crypto';
import {decodeWitness,WITNESS_KINDS,WITNESS_VERSION} from '../src/training/format.js';

const nonGeneratedKinds=new Set(['code','input','observe','value-open','value-part','value-close']);

const chunks=[];
for await(const chunk of process.stdin)chunks.push(chunk);
const raw=Buffer.concat(chunks);
const source=raw.toString('utf8');
let result;
if(!Buffer.from(source,'utf8').equals(raw)){
  result={status:'invalid',reason:'emission is not exact UTF-8'};
}else{
  try{
    const decoded=decodeWitness(source);
    if(!WITNESS_KINDS.includes(decoded.kind)||nonGeneratedKinds.has(decoded.kind)){
      result={status:'invalid',representation:WITNESS_VERSION,kind:decoded.kind,
        reason:'kind is not eligible as a generated semantic target'};
    }else{
      result={status:'valid',representation:WITNESS_VERSION,kind:decoded.kind,
        utf8Bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),
        semanticCorrectness:'not-evaluated'};
    }
  }catch(error){
    result={status:'invalid',representation:WITNESS_VERSION,
      errorType:error?.name??'Error',reason:String(error?.message??error)};
  }
}
process.stdout.write(JSON.stringify(result)+'\n');
