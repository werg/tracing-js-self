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
/** Explicit complete checkpoint cuts; the embedding independently retains the head. */
export declare class DurableSelectedHistoryJournal {
  constructor(options: DurableSelectedHistoryJournalOptions);
  readonly directory: string;
  readonly streamId: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  entryPath(position: number): string;
  append(checkpoint: unknown, options?: {previous?: SelectedHistoryReceipt | null}): Promise<SelectedHistoryReceipt>;
  read(receipt: SelectedHistoryReceipt): Promise<any>;
  readAll(receipt: SelectedHistoryReceipt): Promise<any[]>;
}
