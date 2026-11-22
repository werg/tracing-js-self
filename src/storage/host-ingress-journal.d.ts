export interface HostIngressLogReceipt {
  readonly schema: 'semantic-host-ingress-log-receipt/8';
  readonly streamId: string;
  readonly position: number;
  readonly id: string;
  readonly bytes: number;
}
export interface DurableHostIngressJournalOptions {
  directory: string;
  streamId: string;
  maxBytes?: number;
  maxEntries?: number;
}
/** Node/POSIX immutable arrival log. Receipts are integrity, not authentication. */
export declare class DurableHostIngressJournal {
  constructor(options: DurableHostIngressJournalOptions);
  readonly directory: string;
  readonly streamId: string;
  readonly maxBytes: number;
  readonly maxEntries: number;
  entryPath(position: number): string;
  append(arrival: unknown, options?: {previous?: HostIngressLogReceipt | null}): Promise<HostIngressLogReceipt>;
  read(receipt: HostIngressLogReceipt): Promise<any>;
  readAll(receipt: HostIngressLogReceipt): Promise<any[]>;
  inspectNext(options?: {previous?: HostIngressLogReceipt | null}): Promise<{receipt: HostIngressLogReceipt; entry: any} | null>;
}
/** One intake owner for a V8 harness. Received inputs remain private until delivery. */
export declare class DurableHostIngressBroker {
  constructor(options: {harness: any; journal: DurableHostIngressJournal; receipt?: HostIngressLogReceipt | null});
  readonly receipt: HostIngressLogReceipt | null;
  receive(event: {subscriptionId: string; eventId: string; args?: unknown[]; completionPolicy?: string; deliver?: boolean}): Promise<any>;
  receiveCallback(event: {ownerInvocationId: string; parentEffectId: string; closureId: string;
    invocationId?: string; args?: unknown[]; receiver?: unknown; deliver?: boolean}): Promise<{
      status: 'buffered' | 'delivered' | 'duplicate'; invocationId: string; receipt: HostIngressLogReceipt;
      completion?: Promise<unknown>;
    }>;
  invokeClosure(event: {ownerInvocationId: string; parentEffectId: string; closureId: string;
    args?: unknown[]; receiver?: unknown}): Promise<unknown>;
  hasPending(subscriptionId: string, eventId: string): boolean;
  assertIdle(): void;
  flush(): Promise<HostIngressLogReceipt | null>;
  static recover(options: {harness: any; journal: DurableHostIngressJournal; receipt: HostIngressLogReceipt}): Promise<DurableHostIngressBroker>;
}
