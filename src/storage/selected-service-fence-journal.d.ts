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
}
