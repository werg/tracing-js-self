// Artifact integrity is distinct from witness and outcome correctness.
// Certificates are private; selected trajectories never receive them.
import {isDeepStrictEqual} from 'node:util';
import {validateSemantic} from '../semantic/normalize.js';
import {replayExact} from '../replay.js';
import {compileWitness,COMPACTION_RULES} from './compact.js';
import {SemanticController} from './controller.js';

export function verifyWitnessEvidence(bundle,semantic,compiled) {
  validateSemantic(bundle,semantic);
  replayExact(bundle);
  const expected=compileWitness(bundle,semantic,compiled.policy);
  if(!isDeepStrictEqual(compiled,expected))
    throw new Error('Artifact integrity: compact output/certificates disagree with verified evidence');
  const indexed=new Map(semantic.events.map(e=>[e.id,e]));
  const journalEvents=new Set(bundle.events.map(e=>e.eventId));
  for(const cert of compiled.certificates){
    if(!Object.hasOwn(COMPACTION_RULES,cert.rule) ||
       !Number.isSafeInteger(cert.record) ||
       !compiled.generated[cert.record])
      throw new Error('Artifact integrity: unknown rule or generated record');
    for(const id of cert.journalEvents)
      if(!journalEvents.has(id))
        throw new Error('Artifact integrity: unknown source journal event');
    for(const id of cert.semanticEvents){
      const row=indexed.get(id);
      if(!row||!cert.journalEvents.includes(row.journalEvent))
        throw new Error('Artifact integrity: transformation lacks committed event');
    }
  }
  // The independent primitive checker rejects false declared computations,
  // without relying on the trace compiler's own interpreter semantics.
  const checker=new SemanticController(compiled.context);
  for(const line of compiled.generated)checker.commit(line);
  if(!checker.completion||checker.firstWitnessViolation)
    throw new Error('Artifact integrity: generated public witness is inconsistent'+
      (checker.firstWitnessViolation?': '+JSON.stringify(checker.firstWitnessViolation):
        ': no terminal completion'));
  return {valid:true,certificates:compiled.certificates.length,
    privateEvents:semantic.events.length,generated:compiled.generated.length};
}
