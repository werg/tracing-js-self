// Historical wire client of the shared typed execution state machine.
import {SemanticExecutionController} from '../semantic/execution-controller.js';
import {decodeWitness,encodeWitness,CONTINUATION_VERSION} from './format.js';

export class SemanticController extends SemanticExecutionController {
  static continuationSchema=CONTINUATION_VERSION;
  static initialContext(packet){
    return super.initialContext(packet).map(({kind,fields})=>encodeWitness(kind,fields));
  }
  constructor(context,options){
    super(Array.isArray(context)?context.map(decodeWitness):context,options);
  }
  historyRecord({kind,fields}){return encodeWitness(kind,fields);}
  recordBytes(record){return Buffer.byteLength(this.historyRecord(record),'utf8');}
  commit(line,options){
    if(typeof line!=='string'||Buffer.byteLength(line,'utf8')>65536){
      const error=new Error('Selected semantic record exceeds byte budget');
      error.category='resource-limit';throw error;
    }
    return this.commitRecord(decodeWitness(line),options);
  }
}
