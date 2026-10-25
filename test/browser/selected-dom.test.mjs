import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

test('real Chromium DOM adapter preserves aliases, passive event order, CSP and teardown',async()=>{
  const source=await readFile(new URL('../../src/host/selected-capabilities-browser.js',import.meta.url),'utf8');
  const server=createServer((req,res)=>{
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'none'; style-src 'self'");
    if(req.url==='/capabilities.js'){res.setHeader('Content-Type','text/javascript');res.end(source);}
    else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><main id="scope"><button id="button">before</button></main><aside id="foreign">outside</aside>');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,channel:'chromium',
      ...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{}),
      args:['--no-sandbox']});
    const page=await browser.newPage();
    await page.goto('http://127.0.0.1:'+server.address().port);
    const result=await page.evaluate(async()=>{
      const {createDomServices}=await import('/capabilities.js');
      let next=0;
      const events=[],closed=[],dispositions=[],root=document.querySelector('#scope');
      const dom=createDomServices({root,idFactory:()=>String(++next),onDisposition:r=>dispositions.push(r)});
      const meta={realmId:'realm',sessionId:'session',callback:()=>value=>events.push(value),
        subscriptionId:()=> 'subscription1',closeSubscription:id=>closed.push(id)};
      const handle=dom.services['dom.query'](['#button'],meta);
      const alias=dom.services['dom.query'](['#button'],meta);
      const absent=dom.services['dom.query'](['#foreign'],meta);
      dom.services['dom.setText']([handle,'selected mutation'],meta);
      dom.services['dom.setAttribute']([handle,'aria-label','selected'],meta);
      const token=dom.services['dom.on']([handle,'click',{$ownedCallback:'o1'}],meta);
      const button=document.querySelector('#button');
      const accepted=button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      button.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      const synchronousCount=events.length;
      await Promise.resolve();
      dom.services['dom.off']([token],meta);
      button.dispatchEvent(new MouseEvent('click',{bubbles:true}));await Promise.resolve();
      let crossRealm=false,unsafeAttribute=false,evalBlocked=false;
      try{dom.services['dom.getText']([handle],{...meta,realmId:'foreign'});}catch{crossRealm=true;}
      try{dom.services['dom.setAttribute']([handle,'onclick','forbidden()'],meta);}catch{unsafeAttribute=true;}
      try{window.eval('1+1');}catch{evalBlocked=true;}
      dom.services['dom.startTimer']([100,{$ownedCallback:'o2'}],{
        ...meta,subscriptionId:()=> 'timer1'});
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      return {handle,alias,absent,accepted,synchronousCount,events,closed,crossRealm,
        unsafeAttribute,evalBlocked,text:button.textContent,label:button.getAttribute('aria-label'),
        inspection:dom.inspect(),dispositions};
    });
    assert.equal(result.handle,result.alias);assert.equal(result.absent,'');
    assert.equal(result.text,'selected mutation');assert.equal(result.label,'selected');
    assert.equal(result.accepted,true);assert.equal(result.synchronousCount,0);
    assert.deepEqual(result.events,['click','click']);
    assert.deepEqual(result.closed,['subscription1','timer1']);
    assert(result.crossRealm&&result.unsafeAttribute&&result.evalBlocked);
    assert.equal(result.inspection.closed,true);assert.equal(result.inspection.handles,0);
    assert.equal(result.inspection.listeners,0);assert.equal(result.inspection.timers,0);
  }finally{
    await browser?.close();server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
