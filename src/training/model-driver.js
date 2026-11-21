// Historical selected wire client of neutral model/lifecycle orchestration.
import {SelectedExecutionDriver,selectedRecordFromGroup} from '../semantic/execution-driver.js';
import {decodeWitness,restoreWitness} from './format.js';
import {SelectedExecutionHarness} from './harness-v4.js';

export function selectedWitnessFromGroup(group,trackId){
  return selectedRecordFromGroup(group,trackId,decodeWitness);
}
export class SelectedModelDriver extends SelectedExecutionDriver {
  constructor({harness=new SelectedExecutionHarness(),decodeSelection=decodeWitness,
      restoreFragments=restoreWitness,...options}={}){
    super({...options,harness,decodeSelection,restoreFragments});
  }
}
