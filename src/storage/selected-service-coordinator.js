import {isDeepStrictEqual} from 'node:util';
import {validateServiceAdmissionPolicy,validateServiceFenceReceipt,validateServiceAdmissionFence}
  from '../semantic/service-admission-v8.js';

const copy=structuredClone,eq=isDeepStrictEqual;
const demand=(condition,message)=>{if(!condition)throw new TypeError('Selected service coordinator: '+message);};

/** Supervisor-owned coordination across the declared service sessions. This is
 * ordered fail-closed shutdown, not an atomic transaction across service logs.
 * A partially fenced set stays fenced; an exact retry completes the remainder.
 */
export class SelectedServiceAdmissionCoordinator {
  #members;
  constructor({sessionId,services}={}){
    demand(Array.isArray(services)&&services.length>=1&&services.length<=64,'a bounded service set is required');
    this.#members=services.map(({journal,owner}={})=>{
      demand(journal?.sessionId===sessionId&&typeof journal.serviceId==='string'&&
        typeof journal.terminate==='function'&&typeof journal.inspect==='function',
        'every service needs its independently owned scoped journal');
      validateServiceFenceReceipt(owner,journal.serviceId,sessionId);
      return {serviceId:journal.serviceId,owner:copy(owner),
        terminate:journal.terminate.bind(journal),inspect:journal.inspect.bind(journal)};
    }).sort((left,right)=>left.serviceId<right.serviceId?-1:left.serviceId>right.serviceId?1:0);
    const policy={schema:'semantic-service-admission-policy/8',sessionId,
      serviceIds:this.#members.map(member=>member.serviceId)};
    validateServiceAdmissionPolicy(policy);
    Object.freeze(policy.serviceIds);Object.freeze(policy);
    Object.defineProperty(this,'policy',{value:policy,enumerable:true});
  }
  async #verifyMember(member,row,reason){
    const state=await member.inspect();
    demand(eq(row.owner,member.owner)&&eq(state.owner?.receipt,row.owner)&&
      eq(state.terminal?.owner,row.owner)&&eq(state.terminal?.receipt,row.terminal)&&
      eq(state.head,row.terminal)&&state.terminal?.reason===reason,
      'independent service journal does not acknowledge this exact terminal fence');
  }
  async terminate({sessionId,reason}={}){
    demand(sessionId===this.policy.sessionId&&typeof reason==='string'&&reason.length>0&&
      Buffer.byteLength(reason)<=4096,'the exact session and bounded terminal reason are required');
    const rows=[];
    for(const member of this.#members){
      const terminal=copy(await member.terminate({owner:copy(member.owner),reason})),
        row={serviceId:member.serviceId,owner:copy(member.owner),terminal};
      validateServiceFenceReceipt(terminal,member.serviceId,sessionId);
      await this.#verifyMember(member,row,reason);rows.push(row);
    }
    const fence={schema:'semantic-service-admission-fence/8',sessionId,reason,services:rows};
    validateServiceAdmissionFence(fence,this.policy,reason);return fence;
  }
  async verify(fence){
    fence=copy(fence);validateServiceAdmissionFence(fence,this.policy);
    for(const [index,member]of this.#members.entries())
      await this.#verifyMember(member,fence.services[index],fence.reason);
    return copy(fence);
  }
  async assertActive(){
    for(const member of this.#members){
      const state=await member.inspect();
      demand(state.terminal===null&&eq(state.owner?.receipt,member.owner),
        'service admission is terminal or belongs to a different owner');
    }
    return copy(this.policy);
  }
}
