import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { admission } from './scheduler.mjs';

const { SAM_INFERENCE_UPSTREAM, SAM_INFERENCE_PORT, SAM_INFERENCE_TOKEN, SAM_INFERENCE_UPSTREAM_TOKEN } = process.env;
const upstream = new URL(SAM_INFERENCE_UPSTREAM);
const port = Number(SAM_INFERENCE_PORT);
const waitingMs = Number(process.env.SAM_INFERENCE_QUEUE_TIMEOUT_MS ?? 60000);
if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
    upstream.pathname !== '/' || upstream.search || upstream.hash || upstream.username || upstream.password ||
    !Number.isInteger(port) || port < 1024 || port > 65535 || Number(upstream.port) === port ||
    !Number.isInteger(waitingMs) || waitingMs < 1 || waitingMs > 60000 ||
    typeof SAM_INFERENCE_TOKEN !== 'string' || SAM_INFERENCE_TOKEN.length < 32 ||
    typeof SAM_INFERENCE_UPSTREAM_TOKEN !== 'string' || SAM_INFERENCE_UPSTREAM_TOKEN.length < 32 ||
    SAM_INFERENCE_UPSTREAM_TOKEN === SAM_INFERENCE_TOKEN)
    throw new Error('Configure a separate loopback inference endpoint, ingress port and token');

const scheduler = admission();
const upstreamAuth = { authorization: 'Bearer ' + SAM_INFERENCE_UPSTREAM_TOKEN };
const authorization = Buffer.from('Bearer ' + SAM_INFERENCE_TOKEN);
let needsIdleProof = true;
let unsettled = null;
const resourceKey = process.env.SAM_INFERENCE_RESOURCE_KEY;
const observationToken = process.env.SAM_INFERENCE_OBSERVATION_TOKEN;
const observationEnabled = /^[a-zA-Z0-9_-]{1,64}$/.test(resourceKey ?? '') &&
    typeof observationToken === 'string' && observationToken.length >= 32 &&
    observationToken !== SAM_INFERENCE_TOKEN && observationToken !== SAM_INFERENCE_UPSTREAM_TOKEN;
const observationAuth = Buffer.from('Bearer ' + observationToken);
const ownerEpoch = randomUUID();
let sequence = 0;
let previousRelease = null;
let probe = null;

function matches(supplied, expected) {
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function readSlot(signal) {
    const response = await fetch(new URL('/slots', upstream), {
        headers: upstreamAuth, signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error'
    });
    if (!response.ok) {
        await response.body?.cancel();
        return null;
    }
    const slots = await response.json();
    if (!Array.isArray(slots) || slots.length !== 1 || typeof slots[0]?.is_processing !== 'boolean') return null;
    return { busy: slots[0].is_processing, at: new Date().toISOString() };
}

function observeSlot() {
    if (probe) return probe;
    const attempt = scheduler.snapshot().active;
    const phase = attempt?.phase;
    probe = readSlot(new AbortController().signal)
        .then(slot => {
            const current = scheduler.snapshot().active;
            return current === attempt && current?.phase === phase ? { slot, attempt, phase } : null;
        })
        .catch(() => null)
        .finally(() => { probe = null; });
    return probe;
}

async function observeResource() {
    const observed = await observeSlot();
    const { active, waiting } = scheduler.snapshot();
    const slot = observed?.attempt === active && observed?.phase === active?.phase ? observed?.slot : null;
    const physicalBusy = slot ? Number(slot.busy) : null;
    return {
        contract: 'sam.model-resource.snapshot/v1', resourceKey, ownerEpoch, sequence: ++sequence,
        snapshotAtUtc: new Date().toISOString(), backendObservedAtUtc: slot?.at ?? null,
        appliedMax: slot ? 1 : null, supportedMax: 1,
        state: needsIdleProof ? 'Reconciling' : physicalBusy === null ? 'Unavailable' : active || physicalBusy ? 'Busy' : 'Ready',
        reserved: Number(active !== null), blocked: needsIdleProof, physicalBusy,
        availableForAdmission: slot && !needsIdleProof ? Number(!active && !slot.busy) : null,
        active: active ? [{
            ...active,
            phase: slot?.busy && active.phase === 'Dispatched' ? 'Computing' : active.phase,
            backendStartedAt: slot?.busy && active.phase === 'Dispatched' ? active.backendStartedAt ??= slot.at : null
        }] : [],
        waiting, unsettled, previousRelease
    };
}

async function waitForIdle(signal) {
    while (!signal.aborted) {
        try {
            const slot = await readSlot(signal);
            if (slot?.busy === false) {
                if (unsettled) previousRelease = { attemptId: unsettled.attemptId, at: slot.at, evidence: 'backend-idle', outcome: unsettled.outcome };
                unsettled = null;
                needsIdleProof = false;
                return;
            }
        } catch {
            // A failed probe cannot release the resource.
        }
        await delay(250, undefined, { signal });
    }
    signal.throwIfAborted();
}

function reply(response, status, body, state) {
    if (!response.destroyed && !response.writableEnded) {
        response.writeHead(status, { 'content-type': 'application/json', ...(state ? { 'x-sam-inference-state': state } : {}) });
        response.end(JSON.stringify(body));
    }
}

const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (request.method === 'GET' && request.url === '/resources/v1') {
        if (!observationEnabled) return reply(response, 404, { error: 'route_unavailable' });
        if (!matches(supplied, observationAuth)) return reply(response, 401, { error: 'authentication_required' });
        return reply(response, 200, await observeResource());
    }
    if (!matches(supplied, authorization))
        return reply(response, 401, { error: 'authentication_required' });
    if (request.method === 'GET' && request.url === '/health')
        return reply(response, 200, { capacity: 1, idleProofRequired: needsIdleProof, ...scheduler.read() });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions')
        return reply(response, 404, { error: 'route_unavailable' });

    const role = request.headers['x-sam-inference-role'];
    if (role !== 'agent' && role !== 'processor')
        return reply(response, 400, { error: 'inference_role_required' });
    const disconnected = new AbortController();
    response.on('close', () => disconnected.abort('client_disconnected'));
    const waiting = AbortSignal.any([disconnected.signal, AbortSignal.timeout(waitingMs)]);
    let release;
    let sent = false;
    let correlation = '';
    let entry;
    let settled = false;
    try {
        const body = [];
        let length = 0;
        for await (const chunk of request) {
            length += chunk.length;
            if (length > 1024 * 1024) return reply(response, 413, { error: 'input_too_large' });
            body.push(chunk);
        }
        correlation = String(request.headers['x-sam-correlation-id'] ?? '').slice(0, 128).replace(/[^a-zA-Z0-9_-]/g, '');
        const readReference = name => {
            const value = request.headers[name];
            return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
        };
        entry = {
            attemptId: randomUUID(), role, originRef: readReference('x-sam-correlation-id'),
            runRef: role === 'agent' ? readReference('x-sam-resource-run-id') : null,
            executionRef: role === 'agent' ? readReference('x-sam-resource-execution-id') : null,
            queuedAt: new Date().toISOString(), phase: 'Waiting'
        };
        release = await scheduler.acquire(role, waiting, entry);
        entry.phase = 'Reserved';
        entry.admittedAt = new Date().toISOString();
        if (needsIdleProof) await waitForIdle(waiting);
        waiting.throwIfAborted();
        console.info(JSON.stringify({ event: 'inference_admitted', role, correlation }));
        sent = true;
        entry.phase = 'Dispatched';
        entry.dispatchedAt = new Date().toISOString();
        // Closing the streaming upstream connection requests cancellation in llama.cpp.
        // Disconnect alone is not evidence of an idle slot.
        const generation = AbortSignal.any([disconnected.signal, AbortSignal.timeout(3600000)]);
        const result = await fetch(new URL('/v1/chat/completions', upstream), {
            method: 'POST', headers: { ...upstreamAuth, 'content-type': 'application/json' }, body: Buffer.concat(body),
            redirect: 'error', signal: generation
        });
        if (!response.destroyed)
            response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'application/json' });
        for await (const chunk of result.body ?? []) {
            if (!response.destroyed && !response.write(chunk))
                await once(response, 'drain', { signal: generation });
        }
        if (!response.destroyed) response.end();
        settled = result.ok;
        console.info(JSON.stringify({ event: 'inference_settled', role, correlation, status: result.status }));
    } catch {
        console.warn(JSON.stringify({ event: sent ? 'inference_outcome_unknown' : 'inference_withdrawn', role, correlation }));
        if (response.headersSent) response.destroy();
        else reply(response, sent ? 502 : 503, { error: sent ? 'inference_outcome_unknown' : 'inference_admission_unavailable' },
            sent ? 'unknown' : 'not-dispatched');
    } finally {
        if (sent) {
            // A complete error response can still be ambiguous. Gate the next POST on backend evidence.
            entry.phase = settled ? 'ConfirmingRelease' : 'Unknown';
            entry.outcome = settled ? 'Transport completed' : 'Unknown';
            unsettled = entry;
            needsIdleProof = true;
            try { await waitForIdle(AbortSignal.timeout(1500)); }
            catch { /* The next reservation must obtain its own fresh proof before dispatch. */ }
        }
        release?.();
    }
});

server.listen(port, '127.0.0.1');
