'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../../public/index.html'),'utf8');
const GiB=2**30;
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const helpers=html.slice(html.indexOf('const fmtGiB ='),html.indexOf('function fmtTemp('));
assert.ok(helpers.startsWith('const fmtGiB ='));

test('memory presentation shows byte-derived headroom, stale labels, disabled state and escaped context',()=>{
 const context={esc:escape};vm.createContext(context);vm.runInContext(helpers,context);
 const d={online:true,platform:'linux',lastSeen:Date.now()-4000,latest:{memory:{total:120*GiB,used:109*GiB}},monitoring:{enabled:true,guardBytes:8*GiB,model:'<img src=x onerror=bad>',contextTokens:98304,guardState:'armed'}};
 const value=context.memorySummary(d);assert.equal(value.available,11*GiB);assert.equal(value.headroom,3*GiB);
 assert.match(context.memoryPanel(d),/11\.0 GiB/);assert.match(context.memoryPanel(d),/3\.0 GiB above the 8\.0 GiB guard/);
 assert.ok(!context.memoryPanel(d).includes('<img'));assert.match(context.memoryPanel(d),/&lt;img/);
 d.online=false;assert.match(context.reportState(d),/^No report for/);assert.match(context.memoryPanel(d),/Last known available RAM/);
 d.monitoring.enabled=false;assert.equal(context.reportState(d),'Monitoring disabled');
 d.latest.memory.used=121*GiB;assert.equal(context.memorySummary(d).available,null);assert.equal(context.memoryPanel(d),'');
 d.latest.memory.used=113*GiB;assert.match(context.memoryPanel(d),/1\.0 GiB below/);
 d.platform='macos';assert.equal(context.memorySummary(d).available,null);
});

test('rendering retains known offline and disabled cards in their existing ordered grid positions',()=>{
 const devices=new Map([
  ['a',{id:'a',name:'A',order:0,online:true}],
  ['b',{id:'b',name:'B',order:1,online:false}],
  ['c',{id:'c',name:'C',order:2,online:false,monitoring:{enabled:false}}],
 ]);
 const grid={children:[],insertBefore(el,before){this.children=this.children.filter(c=>c!==el);const at=before?this.children.indexOf(before):-1;this.children.splice(at<0?this.children.length:at,0,el);}};
 const cards=new Map();const summaries=new Map();let updates=[];const removed=[];
 const context={devices,cards,drag:null,$:selector=>{if(selector==='#grid')return grid;if(selector==='.empty')return null;if(!summaries.has(selector))summaries.set(selector,{classList:{toggle(){}}});return summaries.get(selector);},createCard:id=>{const card={el:{dataset:{id},remove(){removed.push(id);grid.children=grid.children.filter(c=>c!==this);}}};cards.set(id,card);return card;},updateCard:id=>updates.push(id),renderOffline(){}};
 vm.createContext(context);const code=html.slice(html.indexOf('function renderGrid()'),html.indexOf('// ---------- offline devices'));
 vm.runInContext(code,context);context.renderGrid();assert.deepEqual(grid.children.map(c=>c.dataset.id),['a','b','c']);assert.deepEqual(updates,['a','b','c']);
 devices.get('a').online=false;updates=[];context.renderGrid();assert.deepEqual(grid.children.map(c=>c.dataset.id),['a','b','c']);assert.deepEqual(removed,[]);assert.deepEqual(updates,['a','b','c']);
 assert.equal(summaries.get('#summaryText').textContent,'0 of 3 devices online');
});

test('drag-end ordering uses unique visible DOM order without appending offline cards twice',()=>{
 const line=html.split('\n').find(line=>/^\s*const ids = .*#grid/.test(line));assert.ok(line);
 const grid={children:[{dataset:{id:'b'}},{dataset:{id:'a'}},{dataset:{id:'c'}}]};
 const context={$:()=>grid,devices:new Map([['a',{id:'a',online:true}],['b',{id:'b',online:false}],['c',{id:'c',online:false}]])};
 const result=vm.runInNewContext(line+'\nJSON.stringify(ids)',context);assert.equal(result,JSON.stringify(['b','a','c']));
});

test('15-second freshness boundary labels old memory stale during server online grace',()=>{
 const now=100000,context={esc:escape,Date:{now:()=>now}};vm.createContext(context);vm.runInContext(helpers,context);
 const d={online:true,lastSeen:now-15000,platform:'linux',latest:{memory:{total:120*GiB,used:109*GiB}},monitoring:{enabled:true,guardBytes:8*GiB}};
 assert.equal(context.isReportStale(d),false);assert.equal(context.reportState(d),'Reporting');assert.ok(!context.memoryPanel(d).includes('Last known'));
 d.lastSeen=now-15001;assert.equal(context.isReportStale(d),true);assert.match(context.reportState(d),/^No report for 15 seconds$/);assert.match(context.memoryPanel(d),/Last known available RAM/);assert.match(context.memoryPanel(d),/11\.0 GiB/);
 d.lastSeen=now-45000;assert.equal(d.online,true);assert.match(context.reportState(d),/^No report for 45 seconds$/);assert.match(context.memoryPanel(d),/last report/);
 d.lastSeen=now;d.hubDisconnected=true;assert.equal(context.isReportStale(d),true);assert.equal(context.reportState(d),'Hub connection lost');
 d.monitoring.enabled=false;assert.equal(context.reportState(d),'Monitoring disabled');
 d.hubDisconnected=false;d.monitoring.enabled=true;d.lastSeen=undefined;assert.equal(context.reportState(d),'Waiting for first report');assert.equal(context.isReportStale(d),true);
});
