import sys,json
sys.path.insert(0,'tests')
from test_promise_executor_v8 import executor_fixture,enter
from megatoken.data.protocol_v8 import apply_protocol_record,_external_machine,validate_protocol_state

def fixture():
 state=executor_fixture()
 state['heap']['target']={'kind':'promise','properties':{},'state':'fulfilled','result':['num',8],'adopted':None,'external':None,'reactions':[]}
 enter(state)
 return state

def resolve(state):
 apply_protocol_record(state,{'kind':'promise.resolver.call','resolver':['ref','resolve-id'],'value':['ref','target']})

results=[]
state=fixture();state['heap']['target']['prototype']=None
try:
 resolve(state);results.append({'case':'explicit-null-prototype-target','accepted':True})
except Exception as error:results.append({'case':'explicit-null-prototype-target','accepted':False,'error':str(error)})
state=fixture();resolve(state)
state['heap']['other']={'kind':'promise','properties':{},'state':'pending','result':None,'adopted':None,'external':None,'reactions':[]}
try:
 apply_protocol_record(state,{'kind':'promise.adopt.enqueue','promise':'other','target':'target','job':'stolen'})
 results.append({'case':'enqueue-other-promise-during-pending-intent','accepted':True,'originalPhase':state['heap']['promise']['adoption']['phase'],'otherPhase':state['heap']['other']['adoption']['phase']})
except Exception as error:results.append({'case':'enqueue-other-promise-during-pending-intent','accepted':False,'error':str(error)})
state=fixture();resolve(state)
apply_protocol_record(state,{'kind':'promise.adopt.enqueue','promise':'promise','target':'target','job':'adopt'})
dict(state['jobs'])['adopt']['extra']=None
try:
 wire=_external_machine(state);validate_protocol_state(wire['protocol'],wire['heap'],wire)
 results.append({'case':'restore-extra-assimilation-job-field','accepted':True})
except Exception as error:results.append({'case':'restore-extra-assimilation-job-field','accepted':False,'error':str(error)})
print(json.dumps({'scope':'direct independent native transition/restore checks, not full source admission','results':results},indent=2))
