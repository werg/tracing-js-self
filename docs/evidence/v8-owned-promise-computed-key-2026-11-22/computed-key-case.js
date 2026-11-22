"use strict";
async function target(){return 1;}
async function run(){
  let order="";
  const p=target();
  const thenKey="then";
  Object.defineProperty(p,thenKey,{get:function(){
    order+="g";
    return function(resolve){order+="t";resolve(2);};
  }});
  async function outer(){return p;}
  const adopted=outer();
  adopted.then(value=>{order+=value;});
  await adopted;
  return order;
}
