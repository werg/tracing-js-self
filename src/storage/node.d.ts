/** POSIX/Node-only persistence for replayable sealed semantic-tracing-run/2 bundles. */
export interface TraceArchiveReceipt {
  readonly id: string;
  readonly bytes: number;
  readonly eventCount: number;
  readonly chunkCount: number;
}
export interface DurableTraceStoreOptions {
  directory: string;
  maxBytes?: number;
}
export declare class TraceStorageError extends Error {}
export declare class DurableTraceStore {
  constructor(options: DurableTraceStoreOptions);
  readonly directory: string;
  readonly maxBytes: number;
  objectPath(id: string): string;
  put(bundle: unknown): Promise<TraceArchiveReceipt>;
  get(id: string): Promise<any>;
  list(): Promise<string[]>;
}
export declare function createDurableTraceStore(options: DurableTraceStoreOptions): DurableTraceStore;

export {DurableRetainedModuleStore,DurableRetainedModuleStorageError,
  createDurableRetainedModuleStore} from './retained-session.js';

export {DurableHostIngressStore,createDurableHostIngressStore} from './host-ingress.js';
export type {HostIngressReceipt,DurableHostIngressStoreOptions} from './host-ingress.js';
export {DurableHostIngressJournal,DurableHostIngressBroker} from './host-ingress-journal.js';
export type {HostIngressLogReceipt,DurableHostIngressJournalOptions} from './host-ingress-journal.js';
export {DurableSelectedHistoryJournal} from './selected-history.js';
export type {SelectedHistoryReceipt,DurableSelectedHistoryJournalOptions,SelectedTerminalSnapshot,
  SelectedTerminalCloseReceipt,SelectedHistoryTerminalEvent,SelectedTerminalDisposition} from './selected-history.js';
export {DurableSelectedServiceJournal} from './selected-service-journal.js';
export type {SelectedServiceAction,SelectedServiceOutcome,SelectedServiceJournalReceipt,
  DurableSelectedServiceJournalOptions} from './selected-service-journal.js';
