import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { admission } from '../../tools/opencode/admission/scheduler.mjs';
import { processor } from '../../tools/opencode/context/processor.mjs';

const target = {
    providerId: 'local', modelId: 'test', endpoint: 'http://127.0.0.1:9999/v1/chat/completions',
    structuredOutput: true, reasoning: true, sharedAdmission: false
};
const input = (timeoutMs = 1000) => ({ operationId: randomUUID(), request: {
    target, timeoutMs, correlationId: randomUUID(), messages: [{ role: 'system', content: 'Return the fixture output.' },
        { role: 'user', content: 'Test' }]
} });

function fixture(execute, records = new Map()) {
    const value = processor({
        options: { processorTargets: [target] },
        experimental: { generate: { completion: { contract: 'opencode.stateless-completion/v1', execute } } },
        storage: { get: async id => records.get(id), set: async (id, row) => records.set(id, structuredClone(row)) }
    }, randomUUID());
    return { start: value.methods['processor-start'], read: value.methods['processor-read'],
        cancel: value.methods['processor-cancel'], ack: value.methods['processor-ack'], records };
}

async function waitFor(read, request, wanted) {
    for (let count = 0; count < 100; count++) {
        const reply = await read(request);
        if (reply.state === wanted) return reply;
        await delay(2);
    }
    assert.fail('Missing state ' + wanted);
}

test('lost acceptance and completion responses recover one durable outcome across a restart', async () => {
    let sent = 0;
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    const native = async () => { sent++; return pending; };
    const first = fixture(native);
    const request = input();
    await Promise.all([first.start(request), first.start(request)]);
    assert.equal(sent, 1);
    await assert.rejects(first.start({ ...request, request: { ...request.request, reasoning: 'high' } }), /already used/);
    const result = { model: target.modelId, provider: target.providerId, text: '{"ok":true}', finishReason: 'stop',
        usage: { promptTokens: 7, completionTokens: 3 } };
    settle({ state: 'succeeded', result });
    await waitFor(first.read, request, 'succeeded');
    const next = fixture(native, first.records);
    assert.deepEqual((await next.start(request)).result, result);
    assert.equal(sent, 1);
});

test('a new epoch preserves an ambiguous dispatch and never repeats it', async () => {
    let sent = 0;
    const native = async () => { sent++; await new Promise(() => {}); };
    const first = fixture(native);
    const request = input(25);
    await first.start(request);
    await waitFor(first.read, request, 'dispatched');
    const next = fixture(native, first.records);
    assert.equal((await next.start(request)).state, 'unknown');
    assert.equal((await next.cancel(request)).state, 'unknown');
    assert.equal(sent, 1);
});

test('operation timeout and explicit cancellation distinguish proved cancellation from ambiguity', async () => {
    const abort = signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    const instance = fixture(async (_request, signal) => {
        await abort(signal);
        return { state: 'cancelled' };
    });
    const timed = input(15);
    await instance.start(timed);
    assert.equal((await waitFor(instance.read, timed, 'failed')).failure, 'processor_timeout');

    const cancelled = input();
    await instance.start(cancelled);
    await waitFor(instance.read, cancelled, 'dispatched');
    await instance.cancel(cancelled);
    await waitFor(instance.read, cancelled, 'cancelled');

    const uncertain = input(15);
    const replay = fixture(async (_request, signal) => { await abort(signal); throw new Error('unconfirmed'); });
    await replay.start(uncertain);
    await waitFor(replay.read, uncertain, 'unknown');
});

test('custom targets must be qualified and a legacy native version advertises no Processor', async () => {
    assert.deepEqual(await processor({ options: { processorTargets: [target] } }, randomUUID()).qualification(), []);
    const request = input();
    request.request.target = { ...target, modelId: 'missing' };
    const instance = fixture(async () => assert.fail('Unexpected upstream call'));
    await instance.start(request);
    assert.equal((await waitFor(instance.read, request, 'failed')).failure, 'processor_target_unqualified');
});

test('Agent waits for running Processor, takes the next slot and cannot starve Processor', async () => {
    const scheduler = admission({ agentBurst: 3 });
    const signal = new AbortController().signal;
    const order = [];
    const submit = role => scheduler.acquire(role, signal).then(release => { order.push(role); release(); });
    const held = await scheduler.acquire('processor', signal);
    const background = Array.from({ length: 3 }, () => submit('processor'));
    const interactive = Array.from({ length: 6 }, () => submit('agent'));
    assert.deepEqual(order, []);
    held();
    await Promise.all([...background, ...interactive]);
    assert.deepEqual(order, [
        'agent', 'agent', 'agent', 'processor', 'agent', 'agent', 'agent', 'processor', 'processor'
    ]);
    assert.deepEqual(scheduler.read(), { active: false, waitingAgent: 0, waitingProcessor: 0 });
});

test('waiting cancellation removes only that request and releases no active slot', async () => {
    const scheduler = admission();
    const signal = new AbortController().signal;
    const release = await scheduler.acquire('processor', signal);
    const waiting = new AbortController();
    const cancelled = scheduler.acquire('agent', waiting.signal);
    waiting.abort(new Error('withdrawn'));
    await assert.rejects(cancelled, /withdrawn/);
    assert.deepEqual(scheduler.read(), { active: true, waitingAgent: 0, waitingProcessor: 0 });
    release();
    (await scheduler.acquire('processor', signal))();
    assert.equal(scheduler.read().active, false);
});

test('a cancellation fence blocks a delayed start with the same operation ID', async () => {
    const instance = fixture(async () => assert.fail('Cancelled operation reached upstream'));
    const operation = input();
    const [cancelled, delayed] = await Promise.all([instance.cancel(operation), instance.start(operation)]);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(delayed.state, 'cancelled');
    assert.equal((await instance.start(operation)).state, 'cancelled');
});


test('receipt retirement verifies connection scope and preserves the no-replay fence', async () => {
    let count = 0;
    const instance = fixture(async () => {
        count++;
        return { state: 'succeeded', result: { text: 'recoverable payload' } };
    });
    const record = { ...input(), connectionId: randomUUID() };
    await instance.start(record);
    const completed = await waitFor(instance.read, record, 'succeeded');
    assert.equal(completed.result.text, 'recoverable payload');
    const other = { ...record, connectionId: randomUUID() };
    await assert.rejects(instance.read(other), /scope changed/);
    await assert.rejects(instance.cancel(other), /scope changed/);
    await assert.rejects(instance.ack(other), /scope changed/);
    assert.deepEqual(await instance.ack(record), { retired: true });
    const retry = await instance.start(record);
    assert.equal(retry.state, 'retired');
    assert.equal(retry.result, undefined);
    assert.equal(count, 1);
});

test('queue capacity rejects excess work without evicting a pending request', async () => {
    const scheduler = admission({ maxWaiting: 1 });
    const signal = new AbortController().signal;
    const release = await scheduler.acquire('processor', signal);
    const pending = scheduler.acquire('agent', signal);
    await assert.rejects(scheduler.acquire('processor', signal), /queue_full/);
    assert.equal(scheduler.read().waitingAgent, 1);
    release();
    (await pending)();
});
