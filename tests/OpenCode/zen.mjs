import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import plugin from '../../tools/opencode/context/index.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const definition = { name: 'sam_test_read', description: 'Read synthetic data', inputSchema: {
    type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };
const catalogue = JSON.stringify([definition]);
const context = 'SYNTHETIC_SAM_CONTEXT';
const input = 'Read the synthetic sample';
const passed = [];
async function fixture(legacy = false, qualifiedModel = 'big-pickle', managed = false) {
    const hooks = new Map(), storage = new Map(), tools = new Map(), transcript = [];
    let rpc, transform;
    const sessionID = 'ses_' + randomUUID().replaceAll('-', '');
    const model = { providerID: managed ? 'dedicated' : legacy ? 'ollama' : 'opencode',
        id: legacy ? 'local-model' : qualifiedModel, variant: 'default' };
    const target = { providerId: model.providerID, modelId: model.id, endpoint: 'http://127.0.0.1:19999/v1/chat/completions',
        structuredOutput: true, reasoning: true, sharedAdmission: true };
    const session = { model, metadata: {} };
    await plugin.setup({ permission: { hook() {} },
        ...(managed ? { options: { processorTargets: [target] }, experimental: { generate: { completion: {
            contract: 'opencode.stateless-completion/v1', execute() { throw new Error('Agent invoked stateless completion'); }
        } } } } : {}),
        session: { get: async () => session, hook: (key, value) => hooks.set(key, value), context: async () => transcript,
            instructions: { entry: { list: async () => [{ key: 'sam-context', value: context }] } } },
        tool: { hook() {}, reload: async () => {}, transform: value => { transform = value; } },
        rpc: { register: (_schema, handlers) => { rpc = handlers; } },
        storage: { get: async key => storage.get(key), set: async (key, value) => { storage.set(key, structuredClone(value)); } }
    });
    const inspect = await rpc.inspect({});
    const authority = { epoch: inspect.epoch, inputId: 'msg_input', model: model.id, catalogDigest: hash(catalogue),
        contextDigest: hash(context), inputDigest: hash(input), ...(legacy ? {} : { modelRequest: managed
            ? { providerId: target.providerId, modelId: target.modelId, endpoint: target.endpoint,
                variant: model.variant, apiFamily: 'sam-local-chat-completions' }
            : inspect.modelRequests.find(scope => scope.modelId === model.id) }) };
    session.metadata.sam = authority;
    await rpc.configure({ catalogue });
    transform({ update() {}, add: tool => tools.set(tool.name, tool) });
    const tool = { description: definition.description, input: definition.inputSchema };
    const projection = {
        sessionID, tools: { [definition.name]: tool },
        system: [{ type: 'text', text: 'Standalone native instructions' }],
        messages: [{ role: 'system', content: 'Native session configuration' },
            { role: 'user', content: input }]
    };
    await hooks.get('context')(projection);
    if (!legacy && !managed) {
        assert.deepEqual(projection.system, [{ type: 'text', text: `<context key="sam-context">\n${context}\n</context>` }]);
        assert.deepEqual(projection.messages, [{ role: 'user', content: input }]);
    }
    const endpoint = legacy ? 'http://127.0.0.1:11434/v1/chat/completions' : authority.modelRequest.endpoint;
    const payload = { model: model.id, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: `<context key="sam-context">\n${context}\n</context>` }, { role: 'user', content: input }],
        tools: [{ type: 'function', function: { name: definition.name, description: definition.description, parameters: definition.inputSchema } }] };
    const request = (body = payload, url = endpoint, method = 'POST', selected = model) => ({
        sessionID, model: selected, kind: 'primary', request: new Request(url, { method, body: JSON.stringify(body) }) });
    async function admit(promise, kind, response = { status: 'ok' }) {
        let finished;
        const observed = promise.then(value => { finished = { value }; }, error => { finished = { error }; });
        while (!finished) {
            const work = (await rpc.poll({ sessionId: sessionID, authority })).work;
            for (const entry of work) {
                assert.equal(entry.kind, kind);
                await rpc.settle({ sessionId: sessionID, authority, ticket: entry.ticket, result: response });
            }
            await setImmediate();
        }
        await observed;
        if (finished.error) throw finished.error;
        return finished.value;
    }
    async function step(event) {
        await admit(hooks.get('http.request')(event), 'model');
        await hooks.get('http.response')({ ...event, response: new Response('{}') });
    }
    return { hooks, rpc, authority, session, model, sessionID, payload, request, step, admit, tools, projection, transcript };
}
for (const qualifiedModel of ['big-pickle', 'deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free']) {
    const f = await fixture(false, qualifiedModel);
    assert.equal(f.authority.modelRequest.modelId, qualifiedModel);
    assert.equal((await f.rpc.inspect({})).zenContext, 'sam.opencode-zen-context/v1');
    await f.step(f.request());
    const other = qualifiedModel === 'big-pickle' ? 'deepseek-v4.1-flash-free' : 'big-pickle';
    await assert.rejects(f.admit(f.hooks.get('http.request')(f.request(undefined, undefined, undefined,
        { ...f.model, id: other })), 'model'), /SAM OpenCode:/);
    passed.push('qualified-scope-' + qualifiedModel);
}
const changes = {
    provider: f => ({ selected: { ...f.model, providerID: 'ollama' } }),
    model: f => ({ selected: { ...f.model, id: 'other-model' } }),
    variant: f => ({ selected: { ...f.model, variant: 'other' } }),
    endpoint: () => ({ url: 'https://example.org/inference/openai/v1/chat/completions' }),
    downgrade: () => ({ url: 'http://opencode.ai/inference/openai/v1/chat/completions' }),
    query: f => ({ url: f.authority.modelRequest.endpoint + '?other=1' }),
    family: () => ({ url: 'https://opencode.ai/inference/openai/v1/responses' }),
    method: () => ({ method: 'PUT' }),
    wireModel: () => ({ mutate: p => { p.model = 'other'; } }),
    stream: () => ({ mutate: p => { p.stream = false; } }),
    context: () => ({ mutate: p => { p.messages[0].content += 'tampered'; p.messages[0].content = p.messages[0].content.replace(context, 'changed'); } }),
    input: () => ({ mutate: p => { p.messages[1].content = 'changed'; } }),
    toolDefinition: () => ({ mutate: p => { p.tools[0].function.parameters.required = []; } }),
    authority: f => { f.authority.modelRequest = { ...f.authority.modelRequest, apiFamily: 'responses' }; return {}; }
};
for (const [label, change] of Object.entries(changes)) {
    const f = await fixture();
    const altered = change(f), body = structuredClone(f.payload);
    altered.mutate?.(body);
    await assert.rejects(f.admit(f.hooks.get('http.request')(f.request(body, altered.url, altered.method, altered.selected)), 'model'), /SAM OpenCode:/);
    passed.push(label);
}
for (const label of ['resultRemoved', 'resultChanged', 'callId', 'arguments', 'toolName', 'valid', 'duplicate']) {
    const f = await fixture();
    await f.step(f.request());
    await f.admit(f.tools.get(definition.name).execute({ key: 'sample' }, {
        id: 'call_read', messageID: 'msg_assistant', sessionID: f.sessionID, signal: new AbortController().signal
    }), 'tool', { status: 'ok', content: 'SYNTHETIC_TOOL_RESULT', success: true });
    const body = structuredClone(f.payload);
    body.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_read', type: 'function',
        function: { name: definition.name, arguments: '{"key":"sample"}' } }] },
    { role: 'tool', tool_call_id: 'call_read', content: 'SYNTHETIC_TOOL_RESULT' });
    if (label === 'resultRemoved') body.messages.pop();
    if (label === 'resultChanged') body.messages.at(-1).content = 'changed';
    if (label === 'callId') body.messages.at(-1).tool_call_id = 'other';
    if (label === 'arguments') body.messages.at(-2).tool_calls[0].function.arguments = '{"key":"other"}';
    if (label === 'toolName') body.messages.at(-2).tool_calls[0].function.name = 'other';
    if (label === 'duplicate') body.messages.push(structuredClone(body.messages.at(-1)));
    if (label === 'valid') {
        const text = 'Synthetic answer before the tool result';
        const assistant = { id: 'msg_assistant', content: [{ type: 'text', text }] };
        f.transcript.push({ ...assistant, type: 'assistant', finish: 'tool-calls' });
        f.projection.messages.push({ ...assistant, role: 'assistant' });
        await f.hooks.get('context')(f.projection);
        body.messages.at(-2).content = text;
        await f.step(f.request(body));
        const receipt = (await f.rpc.inspect({ sessionId: f.sessionID })).receipt;
        assert.deepEqual(receipt.modelRequest, f.authority.modelRequest);
        assert.equal(receipt.steps.length, 2);
        assert.equal(receipt.tools.length, 1);
    } else await assert.rejects(f.admit(f.hooks.get('http.request')(f.request(body)), 'model'), /SAM OpenCode:/);
    passed.push(label);
}
for (const status of [401, 403, 429, 500]) {
    const f = await fixture();
    const event = f.request();
    await f.admit(f.hooks.get('http.request')(event), 'model');
    await f.hooks.get('http.response')({ ...event, response: new Response('SECRET_MUST_NOT_PERSIST',
        { status, headers: { 'Retry-After': '120' } }) });
    const retryEvent = { sessionID: f.sessionID, decision: { retry: true, delay: 100 } };
    await f.hooks.get('retry')(retryEvent);
    assert.deepEqual(retryEvent.decision, { retry: false });
    const receipt = (await f.rpc.inspect({ sessionId: f.sessionID })).receipt;
    assert.equal(receipt.steps[0].httpStatus, status);
    assert.equal(receipt.steps[0].retryAfterSeconds, status === 429 ? 120 : undefined);
    assert.equal(receipt.steps[0].responseObserved, false);
    assert(!JSON.stringify(receipt).includes('SECRET_MUST_NOT_PERSIST'));
    passed.push('http' + status);
}
const retry = await fixture();
await retry.step(retry.request());
await assert.rejects(retry.admit(retry.hooks.get('http.request')(retry.request()), 'model'), /continuation has no new tool results/);
passed.push('ambiguousReplay');
const legacy = await fixture(true);
await legacy.step(legacy.request());
passed.push('legacyOllama');
const managed = await fixture(false, 'managed-model', true);
const managedEvent = managed.request();
await managed.step(managedEvent);
assert.equal(managedEvent.request.headers.get('x-sam-inference-role'), 'agent');
assert.equal(managedEvent.request.headers.get('x-sam-correlation-id'), managed.sessionID);
const foreign = await fixture(false, 'managed-model', true);
const foreignEvent = foreign.request(undefined, 'http://127.0.0.1:19998/v1/chat/completions');
await assert.rejects(foreign.admit(foreign.hooks.get('http.request')(foreignEvent), 'model'), /outside the qualified scope/);
assert.equal(foreignEvent.request.headers.has('x-sam-inference-role'), false);
passed.push('managedLocalAgentAdmission');
console.log(JSON.stringify({ status: 'PASS', cases: passed }));
