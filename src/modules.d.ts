/** Fail-closed static TypeScript/ESM function graph, not a complete module loader. */
export interface StaticModuleRequest {
  modules:Record<string,string>;
  entryModule:string;
  exportName?:string;
  args?:unknown[];
  maxSteps?:number;
}
export interface StaticModuleLink {
  profile:'static-module/1';
  source:string;
  entryFunction:string;
  metadata:{
    profile:string;
    entryModule:string;
    exportName:string;
    functions:Array<{module:string;local:string;linked:string;
      generatedStart:number;generatedEnd:number}>;
    links:Array<{from:string;local:string;module:string;exported:string;binding:string}>;
    modules:Array<{file:string;source:string;transpiler:string;sourceMap:Record<string,unknown>}>;
  };
}
export declare function linkStaticModules(
  request:Omit<StaticModuleRequest,'args'|'maxSteps'>
):StaticModuleLink;
export declare function executeStaticModule(request:StaticModuleRequest):{
  result:unknown;bundle:Record<string,unknown>;metadata:StaticModuleLink['metadata']
};
