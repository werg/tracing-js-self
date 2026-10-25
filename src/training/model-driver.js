// Production selected-output orchestration boundary. This calls a model-selected
// record supplier, never a reference interpreter, implicit native evaluation,
// or teacher correction. Only independently committed broker observations
// can arrive between successive selections.
import {decodeWitness,restoreWitness} from './format.js';
import {SelectedExecutionHarness} from './harness-v4.js';

function fail(message){throw new Error('Selected execution: '+message);}
const copy=value=>structuredClone(value);

/**
 * Adapt one actual Megatoken selected group, not a reconstructed tool envelope.
 * The producer must have validated/committed exactly one text prediction on
 * the requested track. Grouped peer work needs an independent-access proof.
 */
export function selectedWitnessFromGroup(group,trackId){
  const tape=group?.tape;
  if(!tape||!Array.isArray(tape.payloads)||tape.payloads.length!==1||
      tape.valid?.[0]!==true||tape.modalities?.[0]!=='text'||
      tape.tracks?.[0]!==trackId||tape.event_ids?.length!==1)
    fail('Model group must contain one complete committed text selection on its owner');
  const payload=tape.payloads[0];
  if(typeof payload!=='string'||payload.length>65536)
    fail('Selected group must preserve complete canonical witness UTF-8 text');
  const parsed=decodeWitness(payload);
  if(parsed.kind==='observe'||parsed.kind==='code'||parsed.kind==='input')
    fail('Model cannot select host-controlled observations');
  return payload;
}

export class SelectedModelDriver {
  constructor({select,harness=new SelectedExecutionHarness(),maxSelections=4096,
      maxOutstanding=64}={}){
    if(typeof select!=='function')throw new TypeError('An actual selected-model adapter is required');
    if(!Number.isSafeInteger(maxSelections)||maxSelections<1||
       !Number.isSafeInteger(maxOutstanding)||maxOutstanding<1)
      throw new RangeError('Selected inference limits require positive integers');
    this.select=select;this.harness=harness;
    this.maxSelections=maxSelections;this.maxOutstanding=maxOutstanding;
    this.rejections=[];
  }
  /** A caller may keep the harness and invoke the same published code again.
   * The supplier's only inputs are the declared source and visible committed
   * history. Pending native values cannot appear as prediction arguments. */
  async run({programId,source=null,entry=null,capabilities=[],invocationId,trackId,
      realmId,triggerId,args=[],realmPolicy='fresh',completionPolicy='immediate-root',
      selectedEntry=null}){
    if(!this.harness.programs.has(programId)){
      if(typeof source!=='string'||typeof entry!=='string')
        fail('First invocation must publish exact immutable source and entry');
      this.harness.publishProgram({programId,source,entry,capabilities});
    }
    this.harness.admitInvocation({programId,invocationId,trackId,realmId,
      triggerId,args,realmPolicy,completionPolicy,entry:selectedEntry});
    const pending=new Map();
    const completed=[];
    let selected=0;
    const activation=()=>this.harness.invocations.get(invocationId);
    const publicPrefix=()=>{
      const program=this.harness.programs.get(programId);
      const exposed=this.harness.timeline.filter(event=>
        event.kind==='program'&&event.programId===programId ||
        event.invocationId===invocationId);
      return copy({schema:'selected-inference-prefix/1',programId,
        entry:activation().entry,source:program.source,sourceDigest:program.digest,
        invocationId,trackId,realmId,
        committed:exposed,completionPolicy,maxOutstanding:this.maxOutstanding});
    };
    // Only causally available public records reach the model. The broker
    // ledger, native service closures, teacher state and future results do not.
    const invokeModel=async()=>this.select(publicPrefix());
    for(;;){
      if(activation().status==='completed'){
        if(pending.size)await Promise.all(pending.values());
        if(typeof this.select.complete==='function')
          await this.select.complete(publicPrefix());
        const controller=activation().controller;
        let observableGraph=null;
        try{observableGraph=controller.observedGraph();}
        catch(error){
          // A returned owned function/Promise is an internal semantic value,
          // not JSON. Callers such as Natlang use selected handles and make
          // separately modeled later invocations; they never run guest code.
          if(error.category!=='unsupported-boundary')throw error;
        }
        return {completion:copy(controller.completion),
          selectedState:controller.segmentPacket(),
          rendered:this.harness.inspect(invocationId),
          episode:this.harness.exportEpisode(),
          selectedRecords:selected,observableGraph};
      }
      if(selected++>=this.maxSelections)
        fail('Model selection budget exhausted without a complete return/throw');
      let decision=await invokeModel();
      if(decision?.tape)decision=selectedWitnessFromGroup(decision,trackId);
      if(decision&&typeof decision==='object'&&Array.isArray(decision.fragments)){
        const records=restoreWitness(decision.fragments);
        if(records.length!==1)fail('Fragments must reconstruct exactly one semantic record');
        decision=records[0];
      }else if(decision&&typeof decision==='object'&&
               typeof decision.record==='string')decision=decision.record;
      if(decision?.wait===true||decision==='wait'){
        if(!pending.size&&!completed.length)
          fail('A selected wait cannot poll without an outstanding dependency');
        if(!completed.length)await Promise.race(pending.values());
        completed.shift();
        continue;
      }
      if(typeof decision!=='string')
        fail('The model did not produce a complete semantic record');
      let kind,fields;
      try{
        ({kind,fields}=decodeWitness(decision));
        this.harness.selected(invocationId,decision);
      }catch(error){
        // Invalid selected output is auditable, but never dispatches an action.
        this.rejections.push({invocationId,record:decision,error:String(error)});
        throw error;
      }
      if(kind==='request'){
        if(pending.size>=this.maxOutstanding)
          fail('Outstanding native effect budget exhausted');
        const key=fields.effect;
        const work=this.harness.dispatch(invocationId,key);
        pending.set(key,work);
        void work.then(()=>{pending.delete(key);completed.push(key);});
      }
    }
  }
}
