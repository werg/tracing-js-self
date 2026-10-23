/** Acyclic, bounded ES-module source-graph evaluator; not a native ESM loader. */
export interface EvaluatedModulesOptions {
  modules:Record<string,string>;
  entryModule:string;
  exportName?:string;
  args?:unknown[];
}
export interface EvaluatedModulesRunOptions extends EvaluatedModulesOptions {
  maxSteps?:number;
  /** Optional versioned host operation handlers. Native calls are journaled.
   * Allowed names are the bounded demo operation registry, not arbitrary npm or Node APIs. */
  services?:Record<string,(context:import('./host/native-driver.js').NativeHostContext)=>
    string|number|bigint|boolean|null|undefined|
    Promise<string|number|bigint|boolean|null|undefined>>|null;
  signal?:AbortSignal;
}
export interface EvaluatedModulesMetadata {
  profile:'evaluated-module/1';
  entryModule:string;
  exportName:string;
  evaluationOrder:string[];
  linkedBinding:string;
  instantiationAndEvaluation:Array<{
    file:string;
    kind:'instantiate'|'evaluate';
    start:number;
    end:number;
  }>;
  links:Array<{
    from:string;
    local?:string;
    exportName:string;
    source:string;
    imported?:string;
    binding:string;
    live:true;
  }>;
  modules:Array<{
    file:string;
    source:string;
    transpiler:string;
    sourceMap:unknown;
  }>;
}
export function linkEvaluatedModules(options:EvaluatedModulesOptions):{
  profile:'evaluated-module/1';
  source:string;
  entryFunction:string;
  metadata:EvaluatedModulesMetadata;
};
export function executeEvaluatedModules(options:EvaluatedModulesRunOptions):
  Promise<{result:unknown;bundle:unknown;metadata:EvaluatedModulesMetadata}>;
