/** Bounded ES-module evaluator with synchronous cycles and acyclic async
 * dependency scheduling; not a native ESM loader. */
export interface EvaluatedModuleCall {
  /** Named/default export to invoke after the graph is evaluated. */
  exportName:string;
  args:unknown[];
}
export interface EvaluatedModulesOptions {
  modules:Record<string,string>;
  entryModule:string;
  exportName?:string;
  args?:unknown[];
  /** Calls execute in order within one owned realm episode, preserving mutable
   * module lexical bindings, guest object identities and async job ordering.
   * Replaces single-entry args; not persistent across distinct API invocations. */
  calls?:EvaluatedModuleCall[];
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
  /** Every module gets one stable, distinct, extensible null-prototype object
   * with no host-supplied properties, matching the default Node
   * SourceTextModule import-meta hook used by the differential controls. */
  importMetaPolicy:'empty-null-prototype';
  /** Opt-in experimental linker records; this metadata grants no public/native admission. */
  namespaceSourcePlan?:{
    cells:Array<{file:string;local:string;loweredName:string;kind:'let'|'const'|'var'|'function'|'class';mutable:boolean}>;
    namespaces:Array<{file:string;exports:Array<{name:string;file:string;local:string}>}>;
  };
  /** Parallel TLA branches retain per-module environments and dependency
   * records. This strategy is owned-runtime evidence, not public qualification. */
  evaluationStrategy:'dependency-concatenation'|'async-dependency-scheduler';
  evaluationOrder:string[];
  cycles:Array<{path:string;members:string[]}>;
  asyncDependencies?:Array<{
    file:string;
    index:number;
    hasTLA:boolean;
    dependencies:string[];
  }>;
  linkedBinding:string;
  calls?:Array<{exportName:string;binding:string}>;
  instantiationAndEvaluation:Array<{
    file:string|null;
    kind:'instantiate'|'evaluate'|'scheduler-state'|'environment'|'bindings'|
      'module-record'|'instantiate-environment'|'async-scheduler'|
      'async-completion'|'invoke-after-evaluation';
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
export function linkEvaluatedModules(options:EvaluatedModulesOptions&{
  /** Build bounded source-cell records for the unregistered namespace experiment. */
  experimentalNamespacePlan?:boolean;
}):{
  profile:'evaluated-module/1';
  source:string;
  entryFunction:string;
  metadata:EvaluatedModulesMetadata;
  entryInput:{args:unknown[]}|{calls:Array<{args:unknown[]}>};
};
export function executeEvaluatedModules(options:EvaluatedModulesRunOptions):
  Promise<{result:unknown;bundle:unknown;metadata:EvaluatedModulesMetadata}>;

/** Sync effect-free bounded ESM, returning only after full owned replay checks. */
export function executeEvaluatedModulesSync(options:EvaluatedModulesRunOptions):
  {result:unknown;bundle:unknown;metadata:EvaluatedModulesMetadata};
