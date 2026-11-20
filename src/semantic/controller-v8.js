// V8 detail boundary over the neutral typed execution state machine.
import {SemanticExecutionController} from './execution-controller.js';
import {decodeDetailedRecord,encodeDetailedRecord} from './detail-v8.js';

export class SemanticControllerV8 extends SemanticExecutionController {
  static continuationSchema='semantic-continuation/8';
  static initialContext(packet){
    return super.initialContext(packet).map(record=>encodeDetailedRecord(record));
  }
  constructor(context,options){
    super(Array.isArray(context)?context.map(line=>decodeDetailedRecord(line)):context,options);
  }
  historyRecord(record){return encodeDetailedRecord(record);}
  recordBytes(record){return Buffer.byteLength(this.historyRecord(record),'utf8');}
  commit(line,options={}){
    return this.commitRecord(decodeDetailedRecord(line,{role:options.mode??'generated'}),options);
  }
}
