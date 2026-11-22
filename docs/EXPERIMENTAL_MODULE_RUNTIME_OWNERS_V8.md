# Exact runtime owners for module scheduler cuts

This extension builds on the published source-owner replay and existing independent JavaScript/Python scheduler state. It preserves those actions and their explicit refusal of public/data admission. The abstract dependency counter is a derived count of unsettled dependencies; it is not the private linker's transient `record.pending` field.

Each emitted cut now retains the original record ID, generator object, generator body frame/code, definition site, generator allocation event, iterator binding event and final record-assignment event. Definitions are joined through the exact generated `DEF_FN` name and source range. Allocation precedes iterator binding, which precedes publication, and every cut keeps the same original module identity.

A scheduler driver has a different frame from the generator body holding the module environment. A synchronous driver has no execution Promise. An async driver has its actual execution Promise and awaited Promise; consumed `job.enter` events identify resumptions. Async completion also proves the distinct newly allocated reaction callback frame and its original record closure. Synchronous helper completion must follow completion of the exact module generator body.

The six original-source cases continue to compare original ESM lifecycle/outcomes, exact owned execution, every derived action, and actual native state replay. Added owner assertions inspect original event changes directly. A separate public-admission refusal control prevents source ownership metadata from enabling unsupported module execution. Public generator/Promise composition, cyclic graphs, persistent restoration and full production source/native admission remain separate work.

The complete precursor event-time capture is retained with its run/job and original implementation identity. No terminal snapshot supplies authority for these joins.
