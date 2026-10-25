import assert from 'node:assert/strict';
import test from 'node:test';
import {createDomServices} from '../src/host/selected-capabilities-browser.js';

class ControlledElement extends EventTarget {
  constructor(){super();this.textContent='before';this.attrs=new Map();this.deleted=false;}
  setAttribute(key,value){this.attrs.set(key,value);}
  getAttribute(key){return this.attrs.get(key)??null;}
  remove(){this.deleted=true;}
}
const element=new ControlledElement();
const root={querySelector:s=>s==='#item'&&!element.deleted?element:null,
  contains:e=>e===element&&!element.deleted};
const owner={realmId:'realm1',sessionId:'s1'};
let sequence=0;
const setup=()=>createDomServices({root,idFactory:()=>String(++sequence)});

test('browser operations use scope-owned opaque handles and bounded mutation grants',()=>{
  element.deleted=false;element.textContent='before';sequence=0;
  const dom=setup();
  const handle=dom.services['dom.query'](['#item'],owner);
  assert.equal(dom.services['dom.getText']([handle],owner),'before');
  dom.services['dom.setText']([handle,'after'],owner);
  assert.equal(element.textContent,'after');
  dom.services['dom.setAttribute']([handle,'aria-label','counter'],owner);
  assert.equal(dom.services['dom.getAttribute']([handle,'aria-label'],owner),'counter');
  assert.throws(()=>dom.services['dom.setAttribute']([handle,'href','https://evil'],owner),
    /not granted/);
  assert.throws(()=>dom.services['dom.getText']([handle],{...owner,realmId:'r2'}),
    /cross-realm/);
  dom.services['dom.remove']([handle],owner);
  assert.equal(dom.services['dom.query'](['#item'],owner),'');
  assert.throws(()=>dom.services['dom.getText']([handle],owner),/stale|detached/);
  dom.close();
  assert.equal(dom.inspect().closed,true);
});

test('DOM listener emits only asynchronous owned notifications after registration',async()=>{
  element.deleted=false;sequence=0;
  const dom=setup();
  const handle=dom.services['dom.query'](['#item'],owner);
  const events=[],releases=[];
  const meta={...owner,
    callback:slot=>{assert.equal(slot,2);return type=>{events.push(type);};},
    subscriptionId:slot=>{assert.equal(slot,2);return 'callback1';},
    closeSubscription:token=>{releases.push(token);}};
  const token=dom.services['dom.on']([handle,'click',{$ownedCallback:'o1'}],meta);
  assert.equal(token,'callback1');
  element.dispatchEvent(new Event('click'));
  assert.deepEqual(events,[],'native event dispatch cannot execute guest continuation');
  await Promise.resolve();
  assert.deepEqual(events,['click']);
  dom.services['dom.off']([token],meta);
  element.dispatchEvent(new Event('click'));
  await Promise.resolve();
  assert.deepEqual(events,['click']);
  assert.deepEqual(releases,['callback1']);
  dom.close();
});

test('one-shot timer can be cancelled after firing without fabricating another event',async()=>{
  element.deleted=false;sequence=0;
  const dom=setup();
  const events=[];
  const meta={...owner,callback:()=>token=>events.push(token),
    subscriptionId:()=> 'callback2',closeSubscription:()=>{}};
  const token=dom.services['dom.startTimer']([0,{$ownedCallback:'o2'}],meta);
  assert.equal(token,'callback2');
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(events,['callback2']);
  dom.services['dom.stopTimer']([token],meta);
  dom.close();
});
