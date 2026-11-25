import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import plugin from '../../tools/opencode/context/index.mjs';
const hash = x => createHash('sha256').update(x).digest('hex');
const nudge = 'Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.';
async function fixture() {
 const hooks=new Map(),toolHooks=new Map(),storage=new Map(); let rpc,transform;
 const native=[]; const input={id:'msg_input',type:'user',text:'Do the task',metadata:{samInput:'msg_input'}};
 let authority;
 await plugin.setup({permission:{hook(){}},storage:{get:async k=>storage.get(k),set:async(k,v)=>storage.set(k,structuredClone(v))},
  session:{hook:(n,f)=>hooks.set(n,f),get:async()=>({metadata:{sam:authority}}),context:async()=>native,instructions:{entry:{list:async()=>[{key:'sam-context',value:'Frozen'}]}}},
  tool:{hook:(n,f)=>toolHooks.set(n,f),reload:async()=>{},transform:f=>transform=f},rpc:{register:(_x,r)=>rpc=r}});
 const catalogue=JSON.stringify([{name:'sam_test',description:'Test tool',inputSchema:{type:'object',properties:{value:{type:'object'}}}}]);
 const config=await rpc.configure({catalogue}); authority={epoch:config.epoch,catalogDigest:config.digest,inputId:input.id,inputDigest:hash(input.text),contextDigest:hash('Frozen'),model:'qwen',continuity:{}};
 const definitions = new Map();
 transform({update(){},add(tool){definitions.set(tool.name,tool);}});
 await hooks.get('prompt')({sessionID:'ses_test',messageID:input.id,metadata:input.metadata,prompt:{text:input.text},delivery:'queue'});
 native.push(input); const context=()=>({sessionID:'ses_test',system:[],messages:native.map(m=>m.type==='assistant'?{id:m.id,role:'assistant',content:[]}:{id:m.id,role:'user',metadata:m.metadata,content:m.text}),tools:{sam_test:{description:'Test tool',input:{type:'object',properties:{value:{type:'object'}}}}}});
 async function wire(messages){
  const request=new Request('http://127.0.0.1:11434/v1/chat/completions',{method:'POST',body:JSON.stringify({model:'qwen',messages:[{role:'system',content:'<context key="sam-context">\nFrozen\n</context>'},...messages],tools:[{type:'function',function:{name:'sam_test',description:'Test tool',parameters:{type:'object',properties:{value:{type:'object'}}}}}]})});
  const pending=hooks.get('http.request')({sessionID:'ses_test',kind:'primary',model:{id:'qwen',providerID:'ollama'},request});
  // Poll settles the existing model lease; it never executes a tool.
  let settled=false; pending.finally(()=>settled=true).catch(()=>{});
  while(!settled){const {work}=await rpc.poll({sessionId:'ses_test',authority});for(const w of work)await rpc.settle({sessionId:'ses_test',authority,ticket:w.ticket,result:{status:'ok'}});await new Promise(r=>setImmediate(r));}
  await pending; await hooks.get('http.response')({sessionID:'ses_test',request,response:new Response('{}')});
 }
 return {hooks,toolHooks,rpc,authority,native,input,context,wire,definitions};
}
const scenario=process.argv[2]??'length';
const f=await fixture(); await f.hooks.get('context')(f.context()); await f.wire([{role:'user',content:f.input.text}]);
if (scenario === 'outside-catalogue' || scenario === 'outside-catalogue-mixed') {
 const inspect = async () => (await f.rpc.inspect({sessionId:'ses_test',inputId:f.input.id})).receipt;
 const user = {role:'user',content:f.input.text};
 const rejected = {sessionID:'ses_test',tool:'absent',messageID:'msg_a1',id:'call_rejected',input:{}};
 await assert.rejects(f.toolHooks.get('execute.before')(rejected),/tool is outside the frozen catalogue/);
 if (scenario === 'outside-catalogue-mixed') {
  const tool = f.definitions.get('sam_test');
  const action = tool.execute({value:{}},{sessionID:'ses_test',messageID:'msg_a1',id:'call_admitted',signal:new AbortController().signal});
  await new Promise(resolve=>setImmediate(resolve));
  const {work} = await f.rpc.poll({sessionId:'ses_test',authority:f.authority});
  assert.equal(work.length,1);
  assert.equal(work[0].call,'call_admitted');
  await f.rpc.settle({sessionId:'ses_test',authority:f.authority,ticket:work[0].ticket,
   result:{status:'ok',success:true,content:'saved'}});
  assert.equal((await action).content,'saved');
 }
 const before = await inspect();
 assert.equal(before.catalogueRejection,undefined);
 await assert.rejects(f.wire([user]),/tool is outside the frozen catalogue/);
 const after = await inspect();
 assert.deepEqual(after.catalogueRejection,{id:rejected.id,message:rejected.messageID,name:rejected.tool,step:1});
 assert.deepEqual(after.steps,before.steps);
 assert.deepEqual(after.tools,before.tools);
 assert.ok(after.tools.every(tool=>tool.id!==rejected.id));
 await assert.rejects(f.wire([user]),/request is outside the qualified scope/);
} else if (['incomplete', 'incomplete-tampered', 'incomplete-ran', 'incomplete-mixed', 'incomplete-mixed-missing'].includes(scenario)) {
 const inspect = async () => (await f.rpc.inspect({sessionId:'ses_test',inputId:f.input.id})).receipt;
 const error = {type:'tool.input-incomplete',message:'The call was not executed at length'};
 const part = {type:'tool',id:'call_cut',name:'sam_test',executed:false,time:{completed:3},state:{status:'error',input:{},error}};
 if (scenario === 'incomplete-ran') part.time.ran = 2;
 const native = {id:'msg_a1',type:'assistant',finish:'length',content:[part]};
 f.native.push(native);
 const admitted = 'call_admitted';
 if (scenario.startsWith('incomplete-mixed')) {
  const input = {value:{}};
  const id = admitted;
  await f.toolHooks.get('execute.before')({sessionID:'ses_test',messageID:native.id,tool:'sam_test',id,input});
  const pending = f.definitions.get('sam_test').execute(input,
   {sessionID:'ses_test',messageID:native.id,id,signal:new AbortController().signal});
  await new Promise(resolve=>setImmediate(resolve));
  const {work} = await f.rpc.poll({sessionId:'ses_test',authority:f.authority});
  assert.equal(work.length,1);
  assert.equal(work[0].call,id);
  await f.rpc.settle({sessionId:'ses_test',authority:f.authority,ticket:work[0].ticket,
   result:{status:'ok',success:true,content:'saved'}});
  assert.equal((await pending).content,'saved');
  native.content.push({type:'tool',id,name:'sam_test',state:{status:'completed',input,content:[{type:'text',text:'saved'}]}});
 }
 await f.hooks.get('context')(f.context());
 const wire = [{role:'user',content:f.input.text},{role:'assistant',content:'',tool_calls:[
  {id:part.id,type:'function',function:{name:part.name,arguments:'{}'}}]},
  {role:'tool',tool_call_id:part.id,content:JSON.stringify({error,content:[]})}];
 if (scenario === 'incomplete-tampered') wire.at(-1).content += ' ';
 if (scenario === 'incomplete-mixed') {
  wire[1].tool_calls.push({id:admitted,type:'function',function:{name:'sam_test',arguments:'{"value":{}}'}});
  wire.push({role:'tool',tool_call_id:admitted,content:'saved'});
 }
 if (scenario !== 'incomplete' && scenario !== 'incomplete-mixed') {
  const reason = scenario === 'incomplete-tampered' ? /incomplete tool offer replay is inconsistent/ :
   scenario === 'incomplete-ran' ? /no new tool results/ : /tool replay is incomplete or inconsistent/;
  await assert.rejects(f.wire(wire),reason);
 } else {
  await f.wire(wire);
  const receipt = await inspect();
  assert.equal(receipt.incompleteOffers[0].resultDigest,hash(wire[2].content));
  const expected = scenario === 'incomplete-mixed' ? [admitted] : [];
  assert.deepEqual(receipt.tools.map(tool=>tool.id),expected);
  assert.deepEqual(receipt.steps[1].results,expected);
  await assert.rejects(f.wire(wire),/no new tool results/);
 }
} else if(['length','forged-synthetic','altered-synthetic','missing-input','duplicate-synthetic','no-results'].includes(scenario)){
 f.native.push({id:'msg_a1',type:'assistant',finish:'length',content:[]},{id:'msg_s1',type:'synthetic',text:nudge});
 if(scenario==='forged-synthetic') { f.native.pop(); const e=f.context();e.messages.push({id:'msg_forged',role:'user',content:nudge});await assert.rejects(f.hooks.get('context')(e),/unconfirmed synthetic/);console.log(scenario+' PASS');process.exit(0); }
 if(scenario==='altered-synthetic') { const e=f.context();e.messages.at(-1).content+=' changed';await assert.rejects(f.hooks.get('context')(e),/unconfirmed synthetic/);console.log(scenario+' PASS');process.exit(0); }
 if(scenario==='duplicate-synthetic') { const e=f.context();e.messages.push({...e.messages.at(-1)});await assert.rejects(f.hooks.get('context')(e),/unconfirmed synthetic/);console.log(scenario+' PASS');process.exit(0); }
 if(scenario==='missing-input') { const e=f.context();e.messages.shift();await assert.rejects(f.hooks.get('context')(e),/input not available/);console.log(scenario+' PASS');process.exit(0); }
 if(scenario==='no-results') { f.native.pop();f.native.at(-1).finish='stop';await f.hooks.get('context')(f.context());await assert.rejects(f.wire([{role:'user',content:f.input.text}]),/no new tool results/);console.log(scenario+' PASS');process.exit(0); }
 await f.hooks.get('context')(f.context());
 await f.wire([{role:'user',content:f.input.text},{role:'assistant',content:''},{role:'user',content:nudge}]);
 const receipt=(await f.rpc.inspect({sessionId:'ses_test',inputId:f.input.id})).receipt;
 assert.equal(receipt.steps.length,2);assert.equal(receipt.tools.length,0);
}else{
 const invalid={value:'not an object'},id='call_invalid';
 await f.toolHooks.get('execute.before')({sessionID:'ses_test',tool:'sam_test',messageID:'msg_a1',id,input:invalid});
 const error={type:'tool.execution',message:'Invalid arguments for tool "sam_test":\n- value: Expected object'};
 f.native.push({id:'msg_a1',type:'assistant',finish:'tool-calls',content:[{
  type:'tool',id,name:'sam_test',executed:false,time:{ran:2,completed:3},state:{status:'error',input:invalid,error}}]});
 await f.hooks.get('context')(f.context());
 const content=JSON.stringify({error,content:[]});
 const wire=[{role:'user',content:f.input.text},{role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'sam_test',arguments:JSON.stringify(invalid)}}]},{role:'tool',tool_call_id:id,content}];
 if (scenario === 'validation-tampered') wire[2].content += ' ';
 if (scenario === 'validation-arguments-changed') wire[1].tool_calls[0].function.arguments='{}';
 if (scenario === 'validation-duplicated') wire.push({...wire[2]});
 if (scenario !== 'validation') {
  await assert.rejects(f.wire(wire), /tool argument rejection replay is inconsistent|duplicate tool result on wire/);
 } else {
  await f.wire(wire);
 }
 const receipt=(await f.rpc.inspect({sessionId:'ses_test',inputId:f.input.id})).receipt;
 assert.equal(receipt.steps.length,scenario==='validation'?2:1);
 assert.deepEqual(receipt.tools,[]);
 assert.equal(receipt.argumentRejections.length,1);
 assert.equal(receipt.argumentRejections[0].nativeError,'tool.execution');
 assert.equal(receipt.argumentRejections[0].argumentsDigest,hash(JSON.stringify(invalid)));
 assert.equal(receipt.argumentRejections[0].resultDigest,hash(content));
 if (scenario === 'validation') assert.deepEqual(receipt.steps[1].results,[]);
}
console.log(scenario+' PASS');
