// Validate one exact native decoder emission with the production v6 parser.
import {createHash} from 'node:crypto';
import {decodeWitness,WITNESS_VERSION} from '../src/training/format.js';

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
    result={status:'valid',representation:WITNESS_VERSION,kind:decoded.kind,
      utf8Bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex'),
      semanticCorrectness:'not-evaluated'};
  }catch(error){
    result={status:'invalid',representation:WITNESS_VERSION,
      errorType:error?.name??'Error',reason:String(error?.message??error)};
  }
}
process.stdout.write(JSON.stringify(result)+'\n');
