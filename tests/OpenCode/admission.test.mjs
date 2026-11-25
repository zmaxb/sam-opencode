import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const secret = 'fixture-gateway-key-01234567890123456789';
const backend = 'fixture-backend-key-01234567890123456789';

test('the HTTP ingress orders both roles and holds the slot across disconnect and restart', { timeout: 20000 }, async () => {
    let active = null;
    let available = true;
    const order = [];
    const upstream = createServer(async (request, response) => {
        assert.equal(request.headers.authorization, 'Bearer ' + backend);
        if (!available) return response.destroy();
        if (request.url === '/slots') {
            response.end(JSON.stringify([{ is_processing: active !== null }]));
            return;
        }
        assert.equal(request.url, '/v1/chat/completions');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        assert.equal(active, null, 'concurrent upstream inference detected');
        let finish;
        const wait = new Promise(resolve => { finish = resolve; });
        active = finish;
        order.push(input.id);
        await wait;
        active = null;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(input));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const reservation = createSocket();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    reservation.close();
    await once(reservation, 'close');

    const base = 'http://127.0.0.1:' + port;
    const auth = { authorization: 'Bearer ' + secret };
    let ingress;
    const health = async () => (await fetch(base + '/health', { headers: auth })).json();
    async function until(read, match) {
        for (let count = 0; count < 200; count++) {
            try {
                const value = await read();
                if (match(value)) return value;
            } catch (error) {
                if (ingress?.exitCode !== null) throw error;
            }
            await delay(10);
        }
        assert.fail('Condition not observed');
    }
    async function start() {
        ingress = spawn(process.execPath, ['tools/opencode/admission/server.mjs'], {
            stdio: 'ignore', env: {
                ...process.env, SAM_INFERENCE_UPSTREAM: 'http://127.0.0.1:' + upstream.address().port,
                SAM_INFERENCE_PORT: String(port), SAM_INFERENCE_TOKEN: secret, SAM_INFERENCE_UPSTREAM_TOKEN: backend, SAM_INFERENCE_QUEUE_TIMEOUT_MS: "900"
            }
        });
        await until(health, value => value.capacity === 1);
    }
    async function stop() {
        if (!ingress || ingress.exitCode !== null || ingress.signalCode !== null) return;
        ingress.kill('SIGKILL');
        await once(ingress, 'exit');
    }
    const post = (id, role, signal) => fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { ...auth, 'x-sam-inference-role': role }, body: JSON.stringify({ id }), signal
    }).then(response => response.json());
    try {
        await start();
        const disconnected = new AbortController();
        const first = post('P1', 'processor', disconnected.signal);
        await until(() => order.length, value => value === 1);
        const background = post('P2', 'processor');
        await until(health, value => value.waitingProcessor === 1);
        const agent = post('A1', 'agent');
        await until(health, value => value.waitingAgent === 1);
        disconnected.abort();
        await assert.rejects(first, { name: 'AbortError' });
        assert.deepEqual(order, ['P1']);
        active();
        await until(() => order.length, value => value === 2);
        assert.deepEqual(order, ['P1', 'A1']);
        active();
        await agent;
        await until(() => order.length, value => value === 3);
        const abandoned = assert.rejects(background);
        await stop();
        await abandoned;
        await start();
        const recovery = post('A2', 'agent');
        await until(health, value => value.active && value.idleProofRequired);
        assert.deepEqual(order, ['P1', 'A1', 'P2']);
        active();
        await until(() => order.length, value => value === 4);
        assert.deepEqual(order, ['P1', 'A1', 'P2', 'A2']);
        active();
        assert.equal((await recovery).id, 'A2');
        await until(health, value => !value.active && !value.idleProofRequired);
        available = false;
        assert.equal((await post('offline', 'processor')).error, 'inference_outcome_unknown');
        assert.equal((await post('timed-out', 'agent')).error, 'inference_admission_unavailable');
        assert.deepEqual(order, ['P1', 'A1', 'P2', 'A2']);
        available = true;
        const restored = post('after-restart', 'agent');
        await until(() => order.length, value => value === 5);
        active();
        assert.equal((await restored).id, 'after-restart');
    } finally {
        active?.();
        await stop();
        upstream.closeAllConnections();
        upstream.close();
    }
});
