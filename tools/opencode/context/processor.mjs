import { createHash } from 'node:crypto';

export const processorContract = 'sam.opencode-processor/v1';
const nativeContract = 'opencode.stateless-completion/v1';
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const runsByEpoch = new Map();
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'retired']);
const canonical = value => JSON.stringify(value, (_, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function processor(ctx, epoch) {
    const native = ctx.experimental?.generate?.completion;
    const config = ctx.options?.processorTargets;
    const targets = Array.isArray(config) ? config.map(target => ({
        providerId: target?.providerId, modelId: target?.modelId, endpoint: target?.endpoint,
        structuredOutput: target?.structuredOutput === true, reasoning: target?.reasoning === true,
        sharedAdmission: target?.sharedAdmission === true,
        ...(target?.defaults === undefined ? {} : { defaults: target.defaults })
    })) : [];
    const uri = value => {
        try {
            const address = new URL(value);
            return value === address.href && !address.username && !address.password && !address.search &&
                !address.hash && address.pathname.endsWith('/chat/completions') &&
                (address.protocol === 'https:' ||
                    address.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(address.hostname));
        } catch { return false; }
    };
    const name = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
        value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
    const validDefaults = (defaults, supportsReasoning) => defaults === undefined ||
        (defaults && typeof defaults === 'object' && !Array.isArray(defaults) &&
            Object.keys(defaults).every(key => key === 'reasoning' || key === 'maxTokens') &&
            (defaults.reasoning !== undefined || defaults.maxTokens !== undefined) &&
            (defaults.reasoning === undefined || supportsReasoning && name(defaults.reasoning, 64)) &&
            (defaults.maxTokens === undefined || Number.isInteger(defaults.maxTokens) &&
                defaults.maxTokens > 0 && defaults.maxTokens <= 131072));
    if (targets.some(target => !name(target.providerId, 512) || target.providerId.includes('/') ||
        !name(target.modelId, 1024) || !uri(target.endpoint) || !validDefaults(target.defaults, target.reasoning)) ||
        new Set(targets.map(target => target.providerId + '/' + target.modelId)).size !== targets.length)
        throw new Error('Invalid Processor target configuration');
    if (native?.contract !== nativeContract || typeof native.execute !== 'function')
        return { qualification: async () => [], methods: {} };

    const active = runsByEpoch.get(epoch) ?? new Map();
    runsByEpoch.set(epoch, active);
    const storage = id => 'processor/v1/' + id;
    const read = id => ctx.storage.get(storage(id));
    const save = (id, receipt) => ctx.storage.set(storage(id), receipt);
    const maxActive = 64;
    const offline = (record, id) => record && (record.epoch !== epoch || !active.has(id));
    const publicReceipt = (record, id, connectionId) => ({
        contract: processorContract,
        operationId: id,
        ...(connectionId ? { connectionId } : {}),
        state: record && !terminal.has(record.state) && offline(record, id)
            ? record.state === 'accepted' ? 'failed' : 'unknown'
            : record?.state ?? 'missing',
        ...(record?.result === undefined ? {} : { result: record.result }),
        ...(record?.state === 'accepted' && offline(record, id) ? { failure: 'processor_interrupted_before_dispatch' } :
            record?.failure === undefined ? {} : { failure: record.failure }),
        ...(record?.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        ...(record?.finishedAt === undefined ? {} : { finishedAt: record.finishedAt })
    });
    const checkId = value => {
        if (typeof value !== 'string' || !guid.test(value)) throw new Error('Invalid Processor operation ID');
    };
    const fail = (receipt, state, failure) => ({ ...receipt, state, failure });
    const checkScope = (connectionId, record) => {
        if (connectionId !== null) checkId(connectionId);
        if (record && (record.connectionId ?? null) !== connectionId)
            throw new Error('Processor connection scope changed');
    };
    const readScoped = async (id, connectionId) => {
        const record = await read(id);
        checkScope(connectionId, record);
        return record;
    };

    async function execute(id, request, run) {
        let receipt = { digest: run.digest, epoch, connectionId: run.connectionId, state: 'accepted', startedAt: new Date().toISOString() };
        await save(id, receipt);
        run.admit();

        let final;
        if (run.controller.signal.aborted) {
            final = fail(receipt, 'cancelled', 'processor_cancelled');
        } else {
            if (!targets.some(target => canonical(target) === canonical(request.target))) {
                final = fail(receipt, 'failed', 'processor_target_unqualified');
            } else {
                receipt = { ...receipt, state: 'dispatched' };
                // Once committed, this operation can only be read or cancelled, even after a restart.
                await save(id, receipt);
                const timer = setTimeout(() => run.controller.abort('timeout'), request.timeoutMs);
                try {
                    const outcome = await native.execute(request, run.controller.signal);
                    if (outcome?.state === 'succeeded' && outcome.result && Buffer.byteLength(JSON.stringify(outcome.result)) <= 1024 * 1024)
                        final = { ...receipt, state: 'succeeded', result: outcome.result };
                    else if (outcome?.state === 'cancelled')
                        final = fail(receipt, run.controller.signal.reason === 'timeout' ? 'failed' : 'cancelled',
                            run.controller.signal.reason === 'timeout' ? 'processor_timeout' : 'processor_cancelled');
                    else if (outcome?.state === 'failed' && /^[a-z0-9_]{1,80}$/.test(outcome.failure))
                        final = fail(receipt, 'failed', outcome.failure);
                    else final = fail(receipt, 'unknown', 'processor_outcome_unknown');
                } catch {
                    final = fail(receipt, 'unknown', 'processor_outcome_unknown');
                } finally {
                    clearTimeout(timer);
                }
            }
        }
        await save(id, { ...final, finishedAt: new Date().toISOString() });
    }

    async function start({ operationId, request, connectionId = null }) {
        checkId(operationId);
        checkScope(connectionId);
        if (!request || !request.target || !Array.isArray(request.messages) || !request.messages.length ||
            request.messages.length > 256 || request.messages.some(message =>
                !['system', 'developer', 'user', 'assistant'].includes(message?.role) ||
                typeof message.content !== 'string' || !message.content.length || message.content.includes('\0')) ||
            request.variant != null && !name(request.variant, 1024) ||
            request.reasoning != null && !name(request.reasoning, 64) ||
            request.temperature != null && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) ||
            request.topP != null && (!Number.isFinite(request.topP) || request.topP <= 0 || request.topP > 1) ||
            request.maxTokens != null && (!Number.isSafeInteger(request.maxTokens) || request.maxTokens < 1 || request.maxTokens > 131072) ||
            !guid.test(request.correlationId ?? '') ||
            request.responseFormat != null &&
                !['text', 'json_object', 'json_schema'].includes(request.responseFormat?.type) ||
            !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 3600000)
            throw new Error('Invalid Processor request');
        const input = canonical(request);
        if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Processor request is too large');
        const digest = createHash('sha256').update(input).digest('hex');
        const current = active.get(operationId);
        if (current) {
            checkScope(connectionId, current);
            if (current.digest !== null && current.digest !== digest) throw new Error('Processor operation ID already used');
            await current.admitted;
            return publicReceipt(await read(operationId), operationId, connectionId);
        }
        if (active.size >= maxActive) {
            const record = await readScoped(operationId, connectionId);
            if (record?.digest === digest || record?.digest === null) return publicReceipt(record, operationId, connectionId);
            throw new Error('Processor admission unavailable');
        }
        const run = { digest, connectionId, controller: new AbortController() };
        active.set(operationId, run);
        run.admitted = new Promise((resolve, reject) => {
            // Wait for the first durable fact, without coupling inference to the RPC caller's socket.
            run.admit = resolve;
            run.reject = reject;
        });
        void (async () => {
            try {
                const prior = await readScoped(operationId, connectionId);
                if (prior && prior.digest !== null && prior.digest !== digest) throw new Error('Processor operation ID already used');
                if (!prior) await execute(operationId, request, run);
            } catch (error) {
                run.reject(error);
            } finally {
                run.admit();
                active.delete(operationId);
            }
        })();
        // The first call may return a terminal receipt. A lost HTTP response leaves the operation in storage.
        await run.admitted;
        return publicReceipt(await read(operationId), operationId, connectionId);
    }

    return {
        qualification: async () => targets,
        methods: {
            'processor-start': start,
            async 'processor-read'({ operationId, connectionId = null }) {
                checkId(operationId);
                return publicReceipt(await readScoped(operationId, connectionId), operationId, connectionId);
            },
            async 'processor-ack'({ operationId, connectionId }) {
                checkId(operationId);
                checkId(connectionId);
                const fact = await readScoped(operationId, connectionId);
                if (fact?.state === 'succeeded') {
                    const { result: _, ...identity } = fact;
                    await save(operationId, { ...identity, state: 'retired' });
                }
                return { retired: fact?.state === 'succeeded' || fact?.state === 'retired' };
            },
            async 'processor-cancel'({ operationId, connectionId = null }) {
                checkId(operationId);
                checkScope(connectionId);
                const run = active.get(operationId);
                if (run) {
                    checkScope(connectionId, run);
                    run.controller?.abort('cancelled');
                    await run.admitted;
                    return publicReceipt(await read(operationId), operationId, connectionId);
                }
                // A delayed start arriving after cancellation must find the cancellation fence.
                const fence = { digest: null, connectionId, admitted: null };
                active.set(operationId, fence);
                fence.admitted = (async () => {
                    const fact = await readScoped(operationId, connectionId);
                    if (!fact || fact.state === 'accepted') await save(operationId, {
                        epoch, connectionId, digest: fact?.digest ?? null, state: 'cancelled', failure: 'processor_cancelled'
                    });
                })();
                try {
                    await fence.admitted;
                    return publicReceipt(await read(operationId), operationId, connectionId);
                } finally {
                    active.delete(operationId);
                }
            }
        }
    };
}
