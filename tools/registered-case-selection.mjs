// A collection filter, not a new recipe or source inventory. Return the exact
// registered task objects in catalog order; do not relabel or regenerate them.
export function selectRegisteredCaseIds(tasks,caseIds,{recipe,limit=10000}={}){
  if(recipe!=='real-source')throw new TypeError('--case-ids is supported only for the real-source recipe');
  if(!Array.isArray(caseIds)||!caseIds.length||caseIds.some(id=>typeof id!=='string'||!id))
    throw new TypeError('--case-ids must contain a nonempty JSON array of case ID strings');
  const requested=new Set(caseIds);
  if(requested.size!==caseIds.length)throw new TypeError('--case-ids contains duplicate case IDs');
  if(tasks.some(task=>task.kind!=='source'))throw new TypeError('--case-ids cannot filter session or lifecycle tasks');
  const registered=new Set(tasks.map(task=>task.fixture.id));
  if(registered.size!==tasks.length)throw new Error('Registered case IDs are not unique');
  const unknown=caseIds.filter(id=>!registered.has(id));
  if(unknown.length)throw new TypeError('--case-ids contains unknown registered case IDs: '+unknown.join(', '));
  if(limit<requested.size)throw new TypeError('--limit cannot truncate the --case-ids selection');
  return tasks.filter(task=>requested.has(task.fixture.id));
}
