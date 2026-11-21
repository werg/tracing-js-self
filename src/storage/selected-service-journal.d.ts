export interface SelectedServiceAction {
  schema: 'semantic-service-action/8';
  serviceId: string;
  sessionId: string;
  invocationId: string;
  effectId: string;
  operation: string;
  idempotencyKey: string;
  payload: string;
  payloadDigest: string;
  taskRevision: number;
  witness: string;
}
export type SelectedServiceScalar = ['undefined'] | ['null'] | ['bool', boolean] |
  ['str', string] | ['bigint', string] | ['num', number | '-0' | 'NaN' | '+Infinity' | '-Infinity'];
export interface SelectedServiceOutcome {
  schema: 'semantic-service-outcome/8';
  actionDigest: string;
  status: 'fulfilled' | 'rejected';
  result: SelectedServiceScalar;
  errorOrigin: null | 'adapter-throw' | 'adapter-rejection';
}
export interface SelectedServiceJournalReceipt {
  readonly key: string;
  readonly kind: 'claim' | 'outcome';
  readonly digest: string;
  readonly bytes: number;
  readonly claimed: boolean;
}
export interface DurableSelectedServiceJournalOptions {
  /** One service-owned POSIX directory shared by every worker, retained across restarts. */
  directory: string;
  maxBytes?: number;
}
export declare class DurableSelectedServiceJournal {
  constructor(options: DurableSelectedServiceJournalOptions);
  readonly directory: string;
  readonly maxBytes: number;
  claim(action: SelectedServiceAction): Promise<SelectedServiceJournalReceipt>;
  read(action: SelectedServiceAction): Promise<{action: SelectedServiceAction; outcome: SelectedServiceOutcome | null}>;
  complete(action: SelectedServiceAction, outcome: SelectedServiceOutcome,
    receipt: SelectedServiceJournalReceipt): Promise<SelectedServiceJournalReceipt>;
}
