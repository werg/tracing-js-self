/** Private, source-bound queued host inputs. They are never model context. */
export interface HostIngressReceipt {
  readonly schema: 'semantic-host-ingress-receipt/8';
  readonly id: string;
  readonly bytes: number;
}
export interface DurableHostIngressStoreOptions {
  directory: string;
  maxBytes?: number;
}
export declare class DurableHostIngressStore {
  constructor(options: DurableHostIngressStoreOptions);
  readonly directory: string;
  readonly maxBytes: number;
  objectPath(id: string): string;
  put(snapshot: unknown): Promise<HostIngressReceipt>;
  get(receipt: HostIngressReceipt): Promise<any>;
}
export declare function createDurableHostIngressStore(options: DurableHostIngressStoreOptions): DurableHostIngressStore;
