import type {SelectedServiceAction,SelectedServiceOutcome,SelectedServiceJournalReceipt}
  from '../storage/selected-service-journal.js';
export interface SelectedServiceContext {
  sessionId: string;
  invocationId: string;
  effectId: string;
  operation: string;
  idempotencyKey: string;
  selectedAction: Omit<SelectedServiceAction, 'schema' | 'serviceId'>;
  signal?: AbortSignal;
  readonly [key: string]: unknown;
}
export interface SelectedServiceJournal {
  claim(action: SelectedServiceAction): Promise<SelectedServiceJournalReceipt>;
  read(action: SelectedServiceAction): Promise<{action: SelectedServiceAction; outcome: SelectedServiceOutcome | null}>;
  complete(action: SelectedServiceAction, outcome: SelectedServiceOutcome,
    receipt: SelectedServiceJournalReceipt): Promise<SelectedServiceJournalReceipt>;
}
export declare class SelectedServiceBoundaryError extends Error {
  constructor(message: string, options?: {code?: string; cause?: unknown});
  readonly code: string;
}
export declare function createDurableSelectedService(options: {
  serviceId: string;
  operation: string;
  journal: SelectedServiceJournal;
  service: (args: unknown[], context: SelectedServiceContext) => unknown | Promise<unknown>;
}): (args: unknown[], context: SelectedServiceContext) => Promise<unknown>;
