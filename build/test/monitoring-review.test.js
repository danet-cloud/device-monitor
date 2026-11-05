'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const source=path.resolve(__dirname,'../..');
const {startHub}=require(path.join(source,'server'));
const {normalizeMonitoring,MonitoringStore}=require(path.join(source,'monitoring'));
const {Alerts}=require(path.join(source,'alerts'));
const GiB=2**30;
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dm-independent-improvements-'));return dir;}
async function fixture(t,options={}){const dir=temp(t);const hub=await startHub({port:0,dataDir:dir,fixture:true,...options});t.after(()=>{hub.close();fs.rmSync(dir,{recursive:true,force:true});});return {hub,dir,async get(route,key=hub.localKey){const r=await fetch('http://127.0.0.1:'+hub.port+route,{headers:key?{Authorization:'Bearer '+key}:{}});return {status:r.status,body:await r.json()};}};}
const base={id:'independent-edge',hostname:'independent-edge',platform:'linux',memory:{total:120*GiB,used:109*GiB}};

test('trusted metadata explicitly allowlists fields and bounds invalid values',()=>{
 const value=normalizeMonitoring({enabled:true,guardBytes:8*GiB,model:'review-model',contextTokens:98304,runId:'review-run',guardState:'armed',path:'/home/never-public',hosts:['private-host'],token:'never-public'});
 assert.deepEqual(Object.keys(value).sort(),['enabled','guardBytes','model','contextTokens','runId','guardState'].sort());
 assert.equal(normalizeMonitoring({enabled:'true',guardBytes:-1,contextTokens:Infinity,runId:'../../private',guardState:'bogus'}),null);
 assert.equal(normalizeMonitoring([]),null);
});

test('agents cannot spoof monitoring and events require dashboard authentication',async t=>{
 let metadata={enabled:true,guardBytes:8*GiB,model:'review-model',contextTokens:98304,runId:'first-run',guardState:'armed',path:'/home/never-public',token:'never-public'};
 const f=await fixture(t,{metadataProvider:id=>id===base.id?metadata:null});
 f.hub.seedReport({...base,monitoring:{guardBytes:1,model:'agent-forgery'},events:[{type:'guard',title:'agent-forgery'}]});
 const devices=await f.get('/api/devices');assert.equal(devices.status,200);
 const d=devices.body[0];assert.equal(d.monitoring.guardBytes,8*GiB);assert.equal(d.latest.monitoring.model,'review-model');
 assert.ok(!JSON.stringify(devices.body).includes('never-public'));assert.ok(!JSON.stringify(devices.body).includes('agent-forgery'));
 const history=await f.get('/api/history/'+base.id+'?range=1h');assert.equal(history.status,200);
 assert.equal(history.body.points[0].memAvailable,11*GiB);assert.equal(history.body.points[0].guardHeadroom,3*GiB);
 assert.equal((await f.get('/api/events/'+base.id,null)).status,401);
 assert.equal((await f.get('/api/events/'+base.id,f.hub.agentToken)).status,401);
 const events=await f.get('/api/events/'+base.id);assert.equal(events.status,200);assert.ok(events.body.events.length>=2);
 assert.ok(events.body.events.every(e=>Object.keys(e).sort().join(',')==='t,title,type'));
 assert.ok(!JSON.stringify(events.body).includes('never-public'));assert.ok(!JSON.stringify(events.body).includes('agent-forgery'));
 assert.equal((await f.get('/api/events/%2E%2E%2Fprivate')).status,404);
 assert.equal((await f.get('/api/events/'+base.id+'?from=0&to='+Date.now())).status,400);
 metadata={...metadata,model:'review-model-2',runId:'second-run',enabled:false,guardState:'tripped'};
 await f.get('/api/devices');
 const changed=(await f.get('/api/events/'+base.id)).body.events;
 for(const type of ['model','run','monitoring','guard']) assert.ok(changed.some(e=>e.type===type),type);
});

test('metadata callback failures yield unknown without leaking exception material',async t=>{
 const f=await fixture(t,{metadataProvider:()=>{throw new Error('/private/never-public-secret');}});
 f.hub.seedReport({...base,monitoring:{enabled:true,guardState:'armed'}});
 const result=await f.get('/api/devices');assert.equal(result.status,200);assert.equal(result.body[0].monitoring,null);
 assert.ok(!JSON.stringify(result.body).includes('never-public'));
});

test('low-memory persistence, hysteresis, recovery and missing-report gaps',t=>{
 const dir=temp(t);const actualNow=Date.now;let now=100000;Date.now=()=>now;t.after(()=>{Date.now=actualNow;});
 const broadcasts=[];const alerts=new Alerts({dataDir:dir,broadcast:m=>broadcasts.push(m),devices:()=>[{id:base.id,name:'edge',online:true}],latest:()=>null,costToday:()=>null,hubUrl:()=>'',external:false});t.after(()=>{alerts.close();fs.rmSync(dir,{recursive:true,force:true});});
 const cfg=alerts.update({rules:[{id:'123456abcdef',type:'memAvailable',device:base.id,threshold:10,minutes:0.5}],channels:{desktop:true},notifyResolved:true});assert.ok(cfg);
 const events=()=>broadcasts.filter(m=>m.type==='alert').map(m=>m.event.state);
 const report=(seconds,available,enabled=true)=>{now=100000+seconds*1000;alerts.onReport(base.id,{platform:'linux',memory:{total:120*GiB,used:(120-available)*GiB},monitoring:{enabled}});};
 for(const seconds of [0,5,10,15,20,25,29])report(seconds,9);assert.deepEqual(events(),[]);
 report(30,9);assert.deepEqual(events(),['firing']);
 for(const seconds of [35,40,45])report(seconds,10.49);assert.deepEqual(events(),['firing']);
 for(const seconds of [50,55,60,65,70,75,79])report(seconds,10.5);assert.deepEqual(events(),['firing']);
 report(80,10.5);assert.deepEqual(events(),['firing','resolved']);
 for(const seconds of [85,90,95])report(seconds,9);
 report(120,9);assert.deepEqual(events(),['firing','resolved'],'missing reports cannot satisfy low-memory persistence');
 for(const seconds of [125,130,135,140,145,150])report(seconds,9);assert.deepEqual(events(),['firing','resolved','firing']);
 report(155,10.6);report(180,10.6);assert.deepEqual(events(),['firing','resolved','firing'],'missing reports cannot satisfy recovery');
 for(const seconds of [185,190,195,200,205,210])report(seconds,10.6);assert.deepEqual(events(),['firing','resolved','firing','resolved']);
 report(215,9);report(220,9,false);report(225,9);assert.deepEqual(events(),['firing','resolved','firing','resolved']);
 assert.equal(alerts.settings().channels.ntfy.enabled,false);assert.equal(alerts.settings().channels.webhook.enabled,false);
});


test('event persistence rejects malformed roots, unknown types and future timestamps',t=>{
 const dir=temp(t);const file=path.join(dir,'monitoring-events.json');
 fs.writeFileSync(file,'null');
 let store=new MonitoringStore(dir);assert.deepEqual(store.query(base.id,0,Date.now()),[]);store.close();
 const now=Date.now();
 fs.writeFileSync(file,JSON.stringify({events:[
  {id:base.id,t:now-1000,type:'guard',title:'Known guard event',extra:'never-public'},
  {id:base.id,t:now-1000,type:'arbitrary-secret',title:'never-public'},
  {id:base.id,t:now+86400e3,type:'model',title:'never-public'},
  {id:'../../private',t:now-1000,type:'guard',title:'never-public'}
 ],snapshots:{[base.id]:{model:'review-model',guardState:'armed',path:'never-public'}}}));
 store=new MonitoringStore(dir);
 assert.deepEqual(store.query(base.id,now-2000,now),[{t:now-1000,type:'guard',title:'Known guard event'}]);
 store.add(base.id,'not-allowlisted','never-public');store.add(base.id,'guard','never-public',now+86400e3);
 assert.equal(store.query(base.id,0,now+86400e3).length,1);
 store.observe(base.id,{model:'review-model',guardState:'tripped',enabled:true});store.close();
 const persisted=JSON.parse(fs.readFileSync(file));assert.ok(!JSON.stringify(persisted).includes('never-public'));
 store=new MonitoringStore(dir);assert.ok(store.query(base.id,0,Date.now()).some(e=>e.type==='guard'&&e.title.includes('tripped')));
 store.remove(base.id);store.close();
 store=new MonitoringStore(dir);assert.deepEqual(store.query(base.id,0,Date.now()),[]);store.close();fs.rmSync(dir,{recursive:true,force:true});
});
