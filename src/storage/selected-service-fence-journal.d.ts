import type {SelectedServiceAction,SelectedServiceOutcome,SelectedServiceJournalReceipt}
  from './selected-service-journal.js';
import type {SelectedServiceJournal} from '../host/selected-service.js';

/** An immutable transition fact; its owner may already have been superseded. */
export interface SelectedServiceFenceReceipt {
  readonly schema: 'semantic-service-fence-receipt/8';
  readonly serviceId: string;
  readonly sessionId: string;
  readonly position: number;
  readonly id: string;
  readonly bytes: number;
}
export interface SelectedServiceFenceState {
  head: SelectedServiceFenceReceipt | null;
  owner: {generation: number; ownerId: string; receipt: SelectedServiceFenceReceipt} | null;
  terminal: {owner: SelectedServiceFenceReceipt; reason: string; receipt: SelectedServiceFenceReceipt} | null;
  admissions: Array<{key: string; actionDigest: string; owner: SelectedServiceFenceReceipt;
    receipt: SelectedServiceFenceReceipt}>;
  bytes: number;
}
export type SelectedServiceOutcomeReadback =
  | {schema: 'semantic-service-outcome-readback/8'; status: 'unknown'}
  | {schema: 'semantic-service-outcome-readback/8'; status: 'observed'; digest: string;
      bytes: number; record: SelectedServiceOutcome};
export interface SelectedServiceRecoveryAdmission {
  key: string;
  action: SelectedServiceAction;
  actionDigest: string;
  owner: SelectedServiceFenceReceipt;
  fenceClaimReceipt: SelectedServiceFenceReceipt;
  outcome: SelectedServiceOutcomeReadback;
}
export interface SelectedServiceRecoveryListing {
  schema: 'semantic-service-recovery-listing/8';
  serviceId: string;
  sessionId: string;
  head: SelectedServiceFenceReceipt;
  owner: {generation: number; ownerId: string; receipt: SelectedServiceFenceReceipt};
  terminal: {owner: SelectedServiceFenceReceipt; reason: string; receipt: SelectedServiceFenceReceipt};
  actions: SelectedServiceRecoveryAdmission[];
  allOutcomesKnown: boolean;
  digest: string;
}
export interface SelectedServiceActiveRecoveryListing {
  schema: 'semantic-service-active-recovery-listing/8';
  serviceId: string;
  sessionId: string;
  head: SelectedServiceFenceReceipt;
  owner: {generation: number; ownerId: string; receipt: SelectedServiceFenceReceipt};
  terminal: null;
  actions: SelectedServiceRecoveryAdmission[];
  allOutcomesKnown: boolean;
  digest: string;
}
export interface DurableFencedSelectedServiceJournalOptions {
  /** One trusted service-owned POSIX namespace shared by all workers. */
  directory: string;
  serviceId: string;
  sessionId: string;
  maxEntries?: number;
  maxEntryBytes?: number;
  maxLogBytes?: number;
}
export declare class DurableFencedSelectedServiceJournal {
  constructor(options: DurableFencedSelectedServiceJournalOptions);
  readonly directory: string;
  readonly serviceId: string;
  readonly sessionId: string;
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxLogBytes: number;
  readonly scopeDirectory: string;
  /** Supervisor-only: compare with the expected owner, then durably order its successor. */
  advanceOwner(options: {previous?: SelectedServiceFenceReceipt | null; ownerId: string}):
    Promise<SelectedServiceFenceReceipt>;
  /** Supervisor-only: irreversibly fence new admissions; previously admitted work may finish. */
  terminate(options: {owner: SelectedServiceFenceReceipt; reason: string}): Promise<SelectedServiceFenceReceipt>;
  /** Give this bound interface, not the supervisor methods, to a service worker. */
  forOwner(owner: SelectedServiceFenceReceipt): SelectedServiceJournal;
  claim(action: SelectedServiceAction, options: {owner: SelectedServiceFenceReceipt}): Promise<SelectedServiceJournalReceipt>;
  read(action: SelectedServiceAction): Promise<{action: SelectedServiceAction; outcome: SelectedServiceOutcome | null}>;
  complete(action: SelectedServiceAction, outcome: SelectedServiceOutcome,
    receipt: SelectedServiceJournalReceipt): Promise<SelectedServiceJournalReceipt>;
  /** Replays every slot and synchronizes the directory before returning retained authority. */
  inspect(): Promise<SelectedServiceFenceState>;
  /** Reads terminal admissions and immutable outcomes; missing outcomes remain unknown. */
  inspectRecovery(options: {owner: SelectedServiceFenceReceipt; terminal: SelectedServiceFenceReceipt;
    reason: string}): Promise<SelectedServiceRecoveryListing>;
  /** Reads active admissions and outcomes without authorizing child resumption. */
  inspectActiveRecovery(options: {owner: SelectedServiceFenceReceipt}):
    Promise<SelectedServiceActiveRecoveryListing>;
}
