'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const collector=fs.readFileSync(path.join(__dirname,'../../agent/agent-macos.sh'),'utf8');
const code=collector.match(/read -r -d '' AI_PY <<'PY'\n([\s\S]*?)\nPY\n/)[1];
const harness=String.raw`
import contextlib,io,json,os,subprocess,sys,urllib.request
from unittest.mock import patch
from types import SimpleNamespace
payload=json.load(sys.stdin);fixture=payload['fixture'];reads=[]
def run(args,**kwargs):
 if args[0]=='/bin/ps' and '-axo' in args:return SimpleNamespace(stdout=fixture.get('processes',''))
 if args[0]=='/bin/ps' and '-p' in args:
  pid=args[args.index('-p')+1];reads.append(pid);return SimpleNamespace(stdout=fixture.get('commands',{}).get(pid,''))
 return SimpleNamespace(stdout='')
def unavailable(*args,**kwargs):raise OSError('synthetic endpoint unavailable')
with patch('subprocess.run',side_effect=run),patch('urllib.request.urlopen',side_effect=unavailable),patch('os.path.exists',side_effect=lambda p:p in fixture.get('existing',[])):
 output=io.StringIO()
 with contextlib.redirect_stdout(output):exec(compile(payload['code'],'synthetic-collector','exec'),{})
print(json.dumps({'groups':json.loads(output.getvalue()),'pid_arg_reads':reads}))
`;
function probe(fixture){return JSON.parse(execFileSync('python3',['-I','-B','-c',harness],{input:JSON.stringify({code,fixture}),encoding:'utf8',timeout:10000}));}
const secret='TEST_SECRET_MUST_NEVER_BE_EMITTED';
test('detects exact MLX LM and VLM server modules and safe CLI entries without fabricated allocation',()=>{
 const result=probe({processes:'101 /venv/bin/Python\n102 /venv/bin/python3.11\n103 /venv/bin/mlx_vlm\n104 /venv/bin/mlx_lm.server\n105 /venv/bin/Python\n106 /venv/bin/python3\n107 /venv/bin/Python',commands:{
  '101':`/venv/bin/Python -m mlx_vlm server --model /synthetic/models/Orca/8-bit --api-key ${secret}`,
  '102':'/venv/bin/python3.11 -m mlx_lm.server --model mlx-community/Example-4bit',
  '103':'/venv/bin/mlx_vlm server --model=owner/OtherModel',
  '104':'/venv/bin/mlx_lm.server --model=owner/ThirdModel',
  '105':'Python /venv/bin/mlx_vlm server --model owner/ScriptModel',
  '106':'python3 /venv/bin/mlx_lm.server --model owner/ScriptLMModel',
  '107':'Python -I -B -m mlx_vlm server --model owner/FlagsModel',
 },existing:['/synthetic/models/Orca/8-bit']});
 assert.equal(result.groups.length,7);
 assert.deepEqual(result.groups.map(g=>g.models[0].name),['Orca/8-bit','mlx-community/Example-4bit','owner/OtherModel','owner/ThirdModel','owner/ScriptModel','owner/ScriptLMModel','owner/FlagsModel']);
 for(const g of result.groups){assert.equal(g.mem,null);assert.equal(g.models[0].size,null);assert.equal(g.models[0].kind,'service');}
 const output=JSON.stringify(result.groups);assert.ok(!output.includes(secret));assert.ok(!output.includes('/synthetic/'));assert.ok(!output.includes('--api-key'));
});
test('unrelated Python work, cloud clients and non-server MLX invocations do not count as local model services',()=>{
 const result=probe({processes:'201 /venv/bin/python3\n202 /Applications/Codex\n203 /usr/local/bin/claude\n204 /usr/local/bin/node\n205 /venv/bin/Python\n206 /venv/bin/python3\n207 /venv/bin/Python\n208 /venv/bin/Python\n209 /venv/bin/Python',commands:{
  '201':`python3 -m remote_client --model cloud/model --api-key ${secret}`,
  '202':`Codex --model cloud/model --api-key ${secret}`,
  '203':`claude --model cloud/model --api-key ${secret}`,
  '204':`node dsh --model remote/model --api-key ${secret}`,
  '205':'Python -m mlx_vlm generate --model owner/Model',
  '206':'python3 -m mlx_lm.generate --model owner/Model',
  '207':'Python worker.py --model owner/Model',
  '208':'Python unrelated.py -m mlx_lm.server --model owner/NotAServer',
  '209':'Python -c pass -m mlx_lm.server --model owner/NotAServer',
 }});
 assert.deepEqual(result.groups,[]);assert.deepEqual(result.pid_arg_reads,['201','205','206','207','208','209']);
});
test('rejects malformed args, missing model values, credential flags, URLs and nonexistent paths',()=>{
 const commands={
  '301':'Python -m mlx_vlm server',
  '302':'Python -m mlx_lm.server --model',
  '303':`Python -m mlx_vlm server --model --api-key=${secret}`,
  '304':`Python -m mlx_vlm server --model https://user:${secret}@private.example/model`,
  '305':`Python -m mlx_lm.server --model owner/model?api_key=${secret}`,
  '306':'Python -m mlx_vlm server --model /not-present/private-model',
  '307':'Python -m mlx_vlm server --model ./not-present/private-model',
  '308':'Python -m mlx_vlm server --model "unterminated',
  '309':'Python -m mlx_vlm',
  '310':'Python -m mlx_vlm server --model '+('x'.repeat(500)),
 };
 const result=probe({processes:Object.keys(commands).map(pid=>pid+' /venv/bin/Python').join('\n'),commands});
 assert.deepEqual(result.groups,[]);assert.ok(!JSON.stringify(result).includes(secret));
});
test('bounds candidate argument reads and deduplicates matching local services',()=>{
 const commands={'1':'Python -m mlx_vlm server --model owner/Model','2':'Python -m mlx_vlm server --model owner/Model'};
 const processes=Array.from({length:80},(_,i)=>{commands[String(i+1)]??='Python unrelated.py';return(i+1)+' /venv/bin/Python';}).join('\n');
 const result=probe({processes,commands});assert.equal(result.groups.length,1);assert.ok(result.pid_arg_reads.length<=64);
});
