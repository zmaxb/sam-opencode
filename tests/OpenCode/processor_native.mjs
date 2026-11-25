import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.SAM_TEST_OPENCODE_NATIVE_BINARY;
assert.ok(binary, 'Set SAM_TEST_OPENCODE_NATIVE_BINARY to the patched OpenCode executable.');
const directory = await mkdtemp(join(tmpdir(), 'sam-processor-native-'));
const calls = [];
const upstreamToken = randomBytes(24).toString('hex');
const ingressToken = randomBytes(24).toString('hex');
const upstream = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + upstreamToken);
    if (request.url === '/slots') {
        response.end(JSON.stringify([{ is_processing: false }]));
        return;
    }
    const chunks = [];
    for await (const data of request) chunks.push(data);
    const body = JSON.parse(Buffer.concat(chunks));
    calls.push(body);
    const chunk = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: body.model };
    const record = data => 'data: ' + JSON.stringify(data) + '\n\n';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
        record({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: '{"status":"ok"}' }, finish_reason: null }] }) +
        record({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, completion_tokens_details: { reasoning_tokens: 1 }
        } }) + 'data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const portReservation = createSocket();
portReservation.listen(0, '127.0.0.1');
await once(portReservation, 'listening');
const port = portReservation.address().port;
portReservation.close();
await once(portReservation, 'close');

const work = join(directory, 'work');
await mkdir(work);
const config = join(directory, 'opencode.json');
const ingressReservation = createSocket();
ingressReservation.listen(0, '127.0.0.1');
await once(ingressReservation, 'listening');
const ingressPort = ingressReservation.address().port;
ingressReservation.close();
await once(ingressReservation, 'close');
const ingress = spawn(process.execPath, ['tools/opencode/admission/server.mjs'], { stdio: 'ignore', env: {
    ...process.env, SAM_INFERENCE_PORT: String(ingressPort), SAM_INFERENCE_UPSTREAM: 'http://127.0.0.1:' + upstream.address().port,
    SAM_INFERENCE_TOKEN: ingressToken, SAM_INFERENCE_UPSTREAM_TOKEN: upstreamToken
} });
const endpoint = 'http://127.0.0.1:' + ingressPort + '/v1/chat/completions';
const target = { providerId: 'fixture', modelId: 'example-model', endpoint, reasoning: true,
    structuredOutput: true, sharedAdmission: true };
await writeFile(config, JSON.stringify({
    enabled_providers: ['fixture'],
    provider: { fixture: {
        npm: '@ai-sdk/openai-compatible', options: { apiKey: ingressToken, baseURL: endpoint.slice(0, -17) },
        models: { 'example-model': { name: 'Fixture', reasoning: true, modalities: { input: ['text'], output: ['text'] },
            limit: { context: 32768, output: 4096 } } }
    } },
    plugins: [{ package: './sam-opencode-context', options: { processorTargets: [target] } }]
}));
execFileSync('bash', ['tools/opencode/install.sh', '--config', config]);
const password = randomBytes(24).toString('hex');
const authorization = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
let child;
let logs = '';
async function api(path, data) {
    const response = await fetch('http://127.0.0.1:' + port + path, {
        ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
        headers: { authorization, 'content-type': 'application/json' }, signal: AbortSignal.timeout(3000)
    });
    const body = await response.text();
    if (!response.ok) throw new Error(response.status + ' ' + body);
    return JSON.parse(body);
}
const rpc = async (method, input) =>
    (await api('/api/rpc/sam-opencode-context/' + method + '?location%5Bdirectory%5D=' + encodeURIComponent(work), { input })).output;
async function settle(operationId) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const fact = await rpc('processor-read', { operationId });
        if (!['accepted', 'dispatched'].includes(fact.state)) return fact;
        await delay(25);
    }
    assert.fail('OpenCode Processor did not settle');
}
async function start() {
    child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
        cwd: work, env: {
            ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'),
            XDG_STATE_HOME: join(directory, 'state'), XDG_CONFIG_HOME: join(directory, 'config'),
            OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: directory, OPENCODE_PASSWORD: password,
            OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1'
        }, stdio: ['ignore', 'pipe', 'pipe']
    });
    for (const output of [child.stdout, child.stderr]) output.on('data', data => { logs += data; });
    for (let count = 0; count < 100; count++) {
        try {
            await api('/api/info');
            assert.deepEqual((await rpc('inspect', {})).processor?.targets, [target]);
            const catalogue = await api('/api/model?location%5Bdirectory%5D=' + encodeURIComponent(work));
            assert.ok(catalogue.data.some(model => model.enabled && model.providerID === target.providerId &&
                model.id === target.modelId), 'OpenCode has not loaded the fixture model');
            return;
        } catch (error) {
            if (child.exitCode !== null || count === 99) throw error;
            await delay(100);
        }
    }
}
async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await once(child, 'exit');
}
try {
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const ready = await fetch('http://127.0.0.1:' + ingressPort + '/health', {
                headers: { authorization: 'Bearer ' + ingressToken }, signal: AbortSignal.timeout(100)
            });
            if (ready.ok) break;
        } catch {}
        if (attempt === 99) assert.fail('Admission did not start');
        await delay(20);
    }
    await start();
    const before = (await api('/api/session')).data;
    const schema = { name: 'status', strict: true, schema: { type: 'object',
        properties: { status: { const: 'ok' } }, required: ['status'], additionalProperties: false } };
    const operation = { operationId: randomUUID(), request: { target, correlationId: randomUUID(), reasoning: 'medium',
        timeoutMs: 10000, responseFormat: { type: 'json_schema', json_schema: schema },
        messages: [{ role: 'system', content: 'Use the schema.' }, { role: 'user', content: 'Report status.' }] } };
    assert.ok(['accepted', 'dispatched', 'succeeded'].includes((await rpc('processor-start', operation)).state));
    const fact = await settle(operation.operationId);
    assert.equal(fact.state, 'succeeded', JSON.stringify(fact));
    assert.equal(fact.result.model, target.modelId);
    assert.equal(fact.result.finishReason, 'stop');
    assert.equal(fact.result.usage.reasoningCompletionTokens, 1);
    assert.deepEqual(JSON.parse(fact.result.text), { status: 'ok' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].model, target.modelId);
    assert.equal(calls[0].reasoning_effort, 'medium');
    assert.deepEqual(calls[0].response_format.json_schema, schema);
    assert.ok(calls[0].messages.some(message => ['system', 'developer'].includes(message.role) && JSON.stringify(message).includes('Use the schema.')), JSON.stringify(calls[0].messages));
    assert.equal(calls[0].tools, undefined);
    assert.deepEqual((await api('/api/session')).data, before);

    const plain = { operationId: randomUUID(), request: { target, correlationId: randomUUID(), timeoutMs: 10000,
        messages: [{ role: 'user', content: 'Plain text request.' }] } };
    await rpc('processor-start', plain);
    assert.equal((await settle(plain.operationId)).state, 'succeeded');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].response_format, undefined);
    assert.equal(calls[1].messages[0].content, 'Plain text request.');
    const invalid = { operationId: randomUUID(), request: { ...plain.request, target: { ...target, modelId: 'absent' } } };
    await rpc('processor-start', invalid);
    const rejected = await settle(invalid.operationId);
    assert.equal(rejected.failure, 'processor_target_unqualified');
    assert.equal(calls.length, 2);
    await stop();
    await start();
    assert.deepEqual(await rpc('processor-start', operation), fact);
    assert.equal(calls.length, 2);
    console.log('OpenCode Processor native structured output, usage, routing, isolation and restart readback passed.');
} catch (error) {
    console.error(logs.slice(-10000));
    throw error;
} finally {
    await stop();
    if (ingress.exitCode === null && ingress.signalCode === null) {
        ingress.kill('SIGTERM');
        await once(ingress, 'exit');
    }
    upstream.closeAllConnections();
    upstream.close();
    await rm(directory, { recursive: true });
}
