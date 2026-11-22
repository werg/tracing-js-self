import type {SelectedServiceAdmissionFence} from './selected-service-coordinator.js';

export interface SelectedHistoryReceipt {
  readonly schema: 'semantic-selected-history-receipt/8';
  readonly streamId: string;
  readonly position: number;
  readonly id: string;
  readonly bytes: number;
}
export interface DurableSelectedHistoryJournalOptions {
  directory: string;
  streamId: string;
  maxBytes?: number;
  maxEntries?: number;
}
export interface SelectedTerminalSnapshot {
  attempts: unknown[];
  contexts: unknown[];
  staleRetries: number;
  public: unknown;
  rejections: unknown[];
  nativeMetrics: {
    schema: 'semantic-native-model-metrics/8';
    attempts: unknown[];
    runtime: {rpcCalls: number; computeSeconds: number; peakMemoryBytes: number};
    [key: string]: unknown;
  };
}
export interface SelectedTerminalCloseReceipt {
  schema: 'semantic-native-close/8';
  closed: true;
  session: string;
  reason: string;
}
export interface SelectedCompositeTerminalEvent {
  schema: 'semantic-selected-orchestration-terminal-event/8';
  terminalId: string;
  phase: 'completed';
  session: string;
  baseCheckpointDigest: string;
  pendingId: string;
  snapshot: unknown;
  snapshotDigest: string;
  closeReceipt: SelectedTerminalCloseReceipt;
  closedNativeDigest: string;
  closedNative: unknown;
  digest: string;
}
export interface SelectedCompositeTerminalDisposition {
  schema: 'semantic-selected-orchestration-disposition/8';
  status: 'completed';
  resumable: false;
  sourceValidated: false;
  session: string;
  terminalId: string;
  historyReceipt: SelectedHistoryReceipt;
  snapshotDigest: string;
  closeReceipt: SelectedTerminalCloseReceipt;
  initialPublic: unknown;
  public: unknown;
  publicCompleted: true;
  completionReceipts: unknown[];
  nativeIdentity: unknown;
  qualification: {modelMeasurement: string; sourceCorrespondence: string; defaultPromotion: false};
}
export type SelectedHistoryTerminalEvent = {serviceAdmission?: SelectedServiceAdmissionFence} & (
  | {schema: 'semantic-selected-terminal-event/1'; terminalId: string; phase: 'requested';
      session: string; invocationId: string; reason: string; baseCheckpointDigest: string;
      snapshot: SelectedTerminalSnapshot; snapshotDigest: string}
  | {schema: 'semantic-selected-terminal-event/1'; terminalId: string; phase: 'closed';
      session: string; invocationId: string; reason: string; baseCheckpointDigest: string;
      snapshot: SelectedTerminalSnapshot; snapshotDigest: string; closeReceipt: SelectedTerminalCloseReceipt}
  | {schema: 'semantic-selected-terminal-event/1'; terminalId: string; phase: 'unknown';
      session: string; invocationId: string; reason: string; baseCheckpointDigest: string;
      snapshot: SelectedTerminalSnapshot; snapshotDigest: string; failure: string});
export type SelectedTerminalDisposition = {serviceAdmission?: SelectedServiceAdmissionFence} & (
  | {schema: 'semantic-selected-terminal-disposition/1'; phase: 'requested'; status: 'requested';
      terminalId: string; session: string; invocationId: string; reason: string;
      historyReceipt: SelectedHistoryReceipt; snapshotDigest: string}
  | {schema: 'semantic-selected-terminal-disposition/1'; phase: 'closed'; status: 'closed';
      terminalId: string; session: string; invocationId: string; reason: string;
      historyReceipt: SelectedHistoryReceipt; snapshotDigest: string; closeReceipt: SelectedTerminalCloseReceipt}
  | {schema: 'semantic-selected-terminal-disposition/1'; phase: 'unknown'; status: 'unknown';
      terminalId: string; session: string; invocationId: string; reason: string;
      historyReceipt: SelectedHistoryReceipt; snapshotDigest: string; failure: string});
/** Explicit complete checkpoint cuts; the embedding independently retains the head. */
export declare class DurableSelectedHistoryJournal {
  constructor(options: DurableSelectedHistoryJournalOptions);
  readonly directory: string;
  readonly streamId: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  entryPath(position: number): string;
  append(checkpoint: unknown, options?: {previous?: SelectedHistoryReceipt | null;
    terminal?: SelectedHistoryTerminalEvent | SelectedCompositeTerminalEvent; pending?: Record<string, unknown>}): Promise<SelectedHistoryReceipt>;
  read(receipt: SelectedHistoryReceipt): Promise<any>;
  readAll(receipt: SelectedHistoryReceipt): Promise<any[]>;
}
