import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { background } from './background.mjs';
import { processor, processorContract } from './processor.mjs';

const contract = 'sam.opencode-wire/v3';
const steeringContract = 'run-bound-steering/v1';
const steeringMessage = /^msg_steer_[0-9a-f]{32}$/;
const zenContextContract = 'sam.opencode-zen-context/v1';
// Qualification data, not an open-ended provider/URL allow-list. Add models only after native qualification.
const installedZenManifest = new URL('./zen-model-requests.json', import.meta.url);
const zenManifest = existsSync(installedZenManifest) ? installedZenManifest :
    new URL('../../../src/SAM.Runtime.Contracts/AiModels/OpenCodeZenModelRequests.json', import.meta.url);
const { modelIds, ...zenScope } = JSON.parse(readFileSync(zenManifest, 'utf8'));
const modelRequests = modelIds.map(modelId => ({ ...zenScope, modelId }));
const localRequestScope = expected => expected?.modelRequest?.apiFamily === 'sam-local-chat-completions'
    ? expected.modelRequest : null;
const requestScope = expected => {
    if (localRequestScope(expected)) return null;
    const scope = expected.modelRequest;
    if (scope === undefined) return null;
    if (expected.model !== scope?.modelId || !modelRequests.some(item => canonical(item) === canonical(scope)))
        reject('unknown model request scope');
    return scope;
};
const matchesModel = (expected, model) => {
    const scope = localRequestScope(expected) ?? requestScope(expected);
    return model?.providerID === (scope?.providerId ?? 'ollama') && model.id === expected.model &&
        (!scope || (model.variant ?? 'default') === scope.variant);
};
const retryAfterSeconds = (headers, now = Date.now()) => {
    const value = headers.get('retry-after')?.trim();
    if (!value) return undefined;
    let seconds;
    if (/^[0-9]+$/.test(value)) seconds = Number(value);
    else {
        const date = new Date(value);
        if (date.toUTCString() !== value) return undefined;
        seconds = Math.max(0, Math.ceil((date.getTime() - now) / 1000));
    }
    return Number.isSafeInteger(seconds) && seconds <= 2147483647 ? seconds : undefined;
};
const outsideCatalogue = 'tool is outside the frozen catalogue';
const lengthContinuationText = 'Your last response hit the output token limit (stop reason: length). Do not apologize, recap, or repeat yourself. Break the remaining work into smaller pieces.';
const isLengthContinuation = (messages, index) => index > 0 && messages[index].type === 'synthetic' &&
    messages[index].text === lengthContinuationText && messages[index].metadata === undefined &&
    messages[index - 1].type === 'assistant' && messages[index - 1].finish === 'length';
const epoch = randomUUID();
const autonomyContract = 'sam.opencode-autonomy/v1';
const rulesContract = 'sam.opencode-autonomy-rules/v1';
const nativeWrite = 'write';
const nativeEdit = 'edit';
const continuityContract = 'sam.opencode-session-continuity/v1';
const recoveryContract = 'sam.opencode-restart-evidence/v1';
const compactionContract = 'sam.opencode-compaction/v1';
const attachmentsContract = 'sam.opencode-attachments/v1';
const nativeToolsContract = 'sam.opencode-native-tools/v1';
const nativeToolsWithPatchContract = 'sam.opencode-native-tools/v2';
const fileActions = ['edit', 'external_directory'];
const subagentsContract = 'sam.opencode-subagents/v1';
const nativeTools = new Map([
    ['write', 'edit'], ['edit', 'edit'], ['read', 'read'], ['glob', 'glob'], ['grep', 'grep'], ['shell', 'shell'], ['patch', 'edit']
]);
const nativeActions = [...fileActions, 'read', 'glob', 'grep', 'shell'];
const patchInput = {
    type: 'object',
    properties: { patchText: { type: 'string', description: 'The full patch text describing add, update, and delete operations' } },
    required: ['patchText'],
    additionalProperties: false
};
const usesPatch = run => run.expected.nativeTools === nativeToolsWithPatchContract;
const usesNativeTools = run => run.expected.nativeTools === nativeToolsContract || usesPatch(run);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = { type: 'object' };
const approvedRead = 'sam_history_read_with_approval';
const approvalAction = 'sam_read_confirmation';
const validRead = input => typeof input.messageId === 'string' && /^[a-f0-9-]{36}$/i.test(input.messageId) &&
    Number.isSafeInteger(input.revision) && input.revision > 0 && Number.isInteger(input.offset) && input.offset >= 0 &&
    Number.isInteger(input.characters) && input.characters > 0;
const canonical = value => JSON.stringify(value, (_, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const reject = reason => { throw new Error('SAM OpenCode: ' + reason); };


const inlineFiles = expected => expected.attachmentManifest === undefined ? [] :
    JSON.parse(expected.attachmentManifest).filter(file => file.mode !== 'history');
const wireMime = file => file.mode === 'text' ? 'text/plain' : file.mime;
const uriBytes = (uri, mime) => {
    const prefix = `data:${mime};base64,`;
    if (typeof uri !== 'string' || !uri.startsWith(prefix)) reject('attachment type changed');
    const text = uri.slice(prefix.length);
    const bytes = Buffer.from(text, 'base64');
    if (!bytes.length || bytes.toString('base64') !== text) reject('attachment encoding changed');
    return bytes;
};
const verifyPromptFiles = (expected, files) => {
    const authorized = inlineFiles(expected);
    if (files.length !== authorized.length) reject('attachment count changed');
    for (const [index, file] of files.entries()) {
        const entry = authorized[index];
        if (file.name !== entry.name || file.source !== undefined || file.description !== undefined || file.mention !== undefined ||
            sha256(uriBytes(file.uri, wireMime(entry))) !== entry.wireDigest) reject('attachment admission changed');
    }
};
const partsOf = message => typeof message?.content === 'string'
    ? [{ type: 'text', text: message.content }] : message?.content ?? [];
const primaryText = message => partsOf(message)[0]?.type === 'text' ? partsOf(message)[0].text : null;
const matchesInput = (message, expected) => message?.id === expected.inputId &&
    (expected.reportChildId === undefined && expected.child === undefined ? message.metadata?.samInput === expected.inputId :
        typeof primaryText(message) === 'string' && sha256(primaryText(message)) === expected.inputDigest);
const historicalMessages = (run, event) => {
    const ids = run.history.fileInputs;
    if (!ids?.length) return;
    // The native transcript retains its files. Only the original user text is replayed.
    event.messages = event.messages.map(message => message.role === 'user' && ids.includes(message.id)
        ? { ...message, content: partsOf(message).slice(0, 1) } : message);
};
const verifyAttachmentContext = (run, message) => {
    const original = primaryText(message);
    const parts = partsOf(message);
    const expected = inlineFiles(run.expected);
    if (typeof original !== 'string' || sha256(original) !== run.expected.inputDigest || parts.length !== expected.length + 1)
        reject('attachment context changed');
    const proof = [{ type: 'text', digest: run.expected.inputDigest }];
    let plainText = original;
    for (const [index, file] of expected.entries()) {
        const part = parts[index + 1];
        if (file.mode === 'text') {
            const header = `\n\nAttached file: ${file.name}\n\n`;
            if (part.type !== 'text' || !part.text.startsWith(header) || sha256(part.text.slice(header.length)) !== file.wireDigest)
                reject('attachment text changed');
            plainText += part.text;
            proof.push({ type: 'text', digest: sha256(part.text) });
        } else {
            const inline = part.media?.inline?.();
            if (part.type !== 'media' || part.filename !== file.name || inline?.mime !== file.mime ||
                sha256(uriBytes(inline?.dataUrl, file.mime)) !== file.wireDigest) reject('attachment image changed');
            proof.push({ type: 'image_url', mime: file.mime, digest: file.wireDigest });
        }
    }
    run.fileParts = proof.some(part => part.type === 'image_url') ? proof : sha256(plainText);
};
const verifyAttachmentWire = (run, input) => {
    const expected = run.fileParts;
    if (typeof expected === 'string') return typeof input === 'string' && sha256(input) === expected;
    return Array.isArray(expected) && Array.isArray(input) && input.length === expected.length &&
        expected.every((part, index) => {
            const actual = input[index];
            return actual?.type === part.type && (part.type === 'text'
                ? typeof actual.text === 'string' && sha256(actual.text) === part.digest
                : sha256(uriBytes(actual.image_url?.url, part.mime)) === part.digest);
        });
};

export default {
    id: 'sam-opencode-context',
    async setup(ctx) {
        const jobs = background(ctx, epoch);
        const completion = processor(ctx, epoch);
        const processorTargets = await completion.qualification();
        const definitions = new Map();
        const catalogues = new Map();
        let reload = Promise.resolve();
        const wrappedNativeTools = new Set();
        const runs = new Map();
        const armed = new Map();
        const children = new Map();
        let wrappedSubagent = false;
        const childKey = id => 'child/' + id;
        const getChild = async id => children.get(id) ?? await ctx.storage.get(childKey(id));
        const childSourceMatches = (child, sessionId, authority, call) =>
            child?.rootSession === sessionId && child.call === call && canonical(child.root) === canonical(authority);
        const receiptKey = (sessionId, inputId) => `${sessionId}/${inputId}`;
        const runFor = (sessionId, expected) => {
            const catalogue = catalogues.get(expected?.catalogDigest);
            const local = localRequestScope(expected);
            if (local && (expected.model !== local.modelId || typeof local.variant !== 'string' ||
                !processorTargets.some(target => target.sharedAdmission && target.providerId === local.providerId &&
                    target.modelId === local.modelId && target.endpoint === local.endpoint)))
                reject('unknown local model request scope');
            if (expected?.modelRequest !== undefined) requestScope(expected);
            if (expected?.epoch !== epoch || !catalogue) reject('session authority unavailable');
            if (!runs.has(sessionId)) runs.set(sessionId, {
                expected, sessionId, catalogue, steps: [], tools: new Map(), requests: new WeakMap(),
                work: new Map(), native: new Map(), attempts: new Map(), argumentRejections: new Map(), incompleteOffers: new Map(), continuations: [],
                storage: Promise.resolve(), approvals: Promise.resolve(),
                history: { users: [], answers: [], tools: [] }, compactions: []
            });
            const run = runs.get(sessionId);
            if (canonical(run.expected) !== canonical(expected)) reject('session authority changed');
            return run;
        };
        const verifyPermissions = (run, session) => {
            const policy = run.expected.autonomy;
            if (policy === undefined) return;
            const effect = policy.permissionEffect;
            const usesRules = policy.version === 2 && policy.selection === 'approve_for_me' && effect === 'rules';
            if (!usesRules && (policy.version !== 1 || policy.rules !== undefined || !(
                policy.selection === 'ask_for_approval' && effect === 'ask' ||
                policy.selection === 'full_access' && effect === 'allow')))
                reject('invalid frozen permission policy');
            const actions = usesNativeTools(run) ? nativeActions : fileActions;
            const ordered = usesRules ? JSON.parse(policy.rules) : [];
            if (!Array.isArray(ordered) || ordered.some(rule =>
                !rule || Object.keys(rule).length !== 3 || !actions.includes(rule.action) ||
                typeof rule.resource !== 'string' || !rule.resource || !['allow', 'ask', 'deny'].includes(rule.effect)))
                reject('invalid native permission rules');
            const rule = (action, effect) => ({ action, resource: '*', effect });
            const expected = [rule('*', 'deny'), ...[...run.catalogue.keys()].map(name => rule(name, 'allow')),
                rule(approvalAction, usesRules ? 'ask' : effect),
                ...actions.map(action => rule(action, usesRules ? 'ask' : effect)),
                ...(run.expected.subagents === subagentsContract ? [rule('subagent', usesRules ? 'ask' : effect)] : []), ...ordered];
            if (canonical(session.permissions) !== canonical(expected)) reject('session permission policy changed');
            return effect;
        };
        const sessionRun = async sessionId => {
            const session = await ctx.session.get({ sessionID: sessionId });
            const child = session.parentID ? await getChild(sessionId) : null;
            if (!child && !session.metadata?.sam) return null;
            const run = child ? runs.get(sessionId) : runFor(sessionId, session.metadata.sam);
            if (!run || child && (session.parentID !== child.parent || session.location.directory !== child.directory ||
                run.expected.child !== child.call || !matchesModel(run.expected, session.model) ||
                (session.model.variant ?? null) !== child.variant))
                reject('child execution authority unavailable');
            if (run.expected.modelRequest !== undefined && !matchesModel(run.expected, session.model))
                reject('session model request scope changed');
            if (run.expected.nativeTools !== undefined && !usesNativeTools(run)) reject('unknown native tool contract');
            verifyPermissions(run, session);
            return run;
        };
        const registerTool = async (run, id, message, name, input) => {
            const step = run.steps.at(-1);
            if (!step?.responseObserved || run.tools.has(id) || run.argumentRejections.has(id) || run.incompleteOffers.has(id) || run.closed)
                reject('unqualified or duplicate tool call');
            const tool = { id, message, name, step: step.sequence, argumentsDigest: sha256(canonical(input)) };
            run.tools.set(id, tool);
            await persist(run);
            return tool;
        };
        const settleTool = async (run, tool, content, success) => {
            tool.content = content;
            tool.resultDigest = sha256(content);
            tool.success = success;
            await persist(run);
        };
        const receipt = run => ({
            contract, ...run.expected, sessionId: run.sessionId,
            ...(run.recovery ? { recovery: run.recovery } : {}),
            ...(run.argumentRejections.size ? {
                argumentRejections: [...run.argumentRejections.values()].map(({ content, replayInput, ...proof }) => proof)
            } : {}),
            ...(run.catalogueRejection ? { catalogueRejection: run.catalogueRejection } : {}),
            ...(run.incompleteOffers.size ? { incompleteOffers: [...run.incompleteOffers.values()] } : {}),
            ...(run.compactions.length ? { compactions: run.compactions.map(fact => ({ ...fact })) } : {}),
            steps: run.steps.map(({ sequence, requestDigest, results, responseObserved, permissionEffect, checkpointDigest, attachmentDigest, httpStatus, retryAfterSeconds }) =>
                ({ sequence, requestDigest, results, responseObserved, permissionEffect, checkpointDigest, attachmentDigest,
                    ...(httpStatus === undefined ? {} : { httpStatus }),
                    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) })),
            tools: [...run.tools.values()].map(({ content, ...tool }) => tool)
        });
        const persist = run => {
            const snapshot = receipt(run);
            run.storage = run.storage.then(() => ctx.storage.set(snapshot.continuity === undefined ? run.sessionId :
                receiptKey(run.sessionId, run.expected.inputId), snapshot));
            return run.storage;
        };
        const lease = (run, work, signal) => {
            const ticket = randomUUID();
            return new Promise((resolve, rejectWork) => {
                const cancel = () => {
                    run.work.delete(ticket);
                    signal?.removeEventListener('abort', cancel);
                    rejectWork(new Error('SAM OpenCode: work interrupted'));
                };
                if (signal?.aborted) return cancel();
                signal?.addEventListener('abort', cancel, { once: true });
                run.work.set(ticket, {
                    public: { ticket, ...work },
                    cancel,
                    complete(result) {
                        run.work.delete(ticket);
                        signal?.removeEventListener('abort', cancel);
                        resolve(result);
                    }
                });
            });
        };

        const serialApproval = (run, callback) => {
            const next = run.approvals.then(callback);
            run.approvals = next.catch(() => {});
            return next;
        };

        const approveRead = (run, work, context) => serialApproval(run, async () => {
            if (context.signal.aborted) reject('approval withdrawn');
            if (!validRead(work.arguments)) return lease(run, work, context.signal);
            // OpenCode reject applies to the pending permission batch. Keep this
            // session's confirmations serial and bind each ask to its tool call.
            const approval = ctx.permission.assert({
                sessionID: context.sessionID, action: approvalAction, resources: [work.call],
                source: { type: 'tool', id: work.call, messageID: work.message }
            }).then(() => true, () => false);
            try {
                const response = await lease(run, work, context.signal);
                if (!['ok', 'rejected'].includes(response.status)) reject('approval result unavailable');
                if (await approval !== (response.status === 'ok')) reject('approval outcome mismatch');
                return response;
            } finally {
                // The Promise SDK does not bind permission.assert to the tool's
                // AbortSignal. Close the precise permission if it is still pending.
                const pending = await ctx.permission.list({ sessionID: context.sessionID }).catch(() => []);
                const own = pending.find(request =>
                    request.action === approvalAction && request.source?.id === work.call &&
                    request.source?.messageID === work.message && request.resources.length === 1 &&
                    request.resources[0] === work.call);
                if (own) await ctx.permission.reply({
                    sessionID: context.sessionID, requestID: own.id, decision: 'reject'
                }).catch(() => {});
            }
        });

        await ctx.permission.hook('evaluate', async event => {
            const run = runs.get(event.sessionID);
            const tool = run?.tools.get(event.source?.id);
            if (!tool || tool.message !== event.source.messageID) return;
            if (tool.name === approvedRead && event.action === approvalAction &&
                event.resources.length === 1 && event.resources[0] === tool.id) {
                event.effect = run.expected.autonomy?.permissionEffect === 'allow' ? 'allow' : 'ask';
                return;
            }
            const native = run.native.get(tool.id);
            if (!native) return;
            if (!native.actions.includes(event.action)) return; // OpenCode also tests optional read/skill permissions.
            await sessionRun(event.sessionID);
            const { action, resources } = event;
            const policy = run.expected.autonomy;
            if (policy.version === 2 || usesNativeTools(run)) {
                // The engine selects the rule. SAM verifies the session and the absence of
                // external saved grants before OpenCode can complete this permission check.
                const confirmed = await lease(run, { kind: 'native-permission', call: tool.id, message: tool.message,
                    name: tool.name, arguments: { action, resources, effect: event.effect } }, native.signal).catch(() => null);
                if (confirmed?.status !== 'ok' || native.signal.aborted) {
                    event.effect = 'deny';
                    native.withdrawn = true;
                    return;
                }
            } else {
                // Saved project grants must not turn a SAM Ask into a permanent permission.
                event.effect = policy.permissionEffect;
            }
            native.effects.set(action, event.effect);
            if (policy.version === 2 || usesNativeTools(run))
                (tool.permissions ??= []).push({ action, resources, effect: event.effect });
            if (event.effect !== 'ask' || run.expected.child !== undefined) return;
            const reply = lease(run, { kind: 'permission', call: tool.id, message: tool.message, name: tool.name,
                arguments: { action, resources, ...(native.command === undefined ? {} : { command: native.command }),
                    ...(native.workdir === undefined ? {} : { workdir: native.workdir }) } }, native.signal);
            // Return from the hook before SAM polls: OpenCode creates the request after this hook.
            native.replies.push(reply);
            reply.catch(() => {});
        });

        let patchDescription;
        await ctx.tool.transform(editor => {
            wrappedNativeTools.clear();
            wrappedSubagent = false;
            editor.update('subagent', tool => {
                wrappedSubagent = true;
                const execute = tool.execute;
                tool.execute = async (input, context) => {
                    const run = await sessionRun(context.sessionID);
                    if (!run) return execute(input, context);
                    if (!allowsNativeTool(run, 'subagent') || !run.nativeDefinitions?.has('subagent')) reject('subagent is outside the frozen catalogue');
                    return serialApproval(run, () => executeNative(run, 'subagent', 'subagent', execute, input, context, context.signal));
                };
            });
            patchDescription = undefined;
            for (const [name, action] of nativeTools) editor.update(name, tool => {
                if (action === 'edit' && tool.options?.permission !== 'edit' ||
                    name === 'shell' && tool.description.includes('Commands still running after their timeout move to the background.')) return;
                wrappedNativeTools.add(name);
                if (name === 'patch') patchDescription = tool.description;
                const execute = tool.execute;
                tool.execute = async (input, context) => {
                    const run = await sessionRun(context.sessionID);
                    if (!run) return execute(input, context);
                    if (!allowsTool(run, name)) reject('native tool is outside the frozen execution policy');
                    const signal = context.signal;
                    if (usesNativeTools(run))
                        return serialApproval(run, () => executeNative(run, name, action, execute, input, context, signal));
                    const invoke = async () => {
                        if (signal.aborted) reject('native call withdrawn');
                        const evidence = await registerTool(run, context.id, context.messageID, name, input);
                        const native = { signal, replies: [], effects: new Map(), actions: fileActions };
                        run.native.set(context.id, native);
                        try {
                            const admission = await lease(run, { kind: 'native', call: evidence.id, message: evidence.message,
                                name: evidence.name, arguments: input }, signal);
                            if (admission.status !== 'ok' || signal.aborted) reject('native call withdrawn');
                            let result;
                            try { result = await execute(input, context); }
                            catch (error) {
                                const replies = await Promise.all(native.replies);
                                if (signal.aborted || native.withdrawn) throw error;
                                const rejected = replies.some(reply => reply.status === 'rejected');
                                if (!rejected) {
                                    const refusal = error.error ?? error.cause?.error;
                                    if (run.expected.autonomy.version !== 2 || refusal?._tag !== 'Permission.BlockedError')
                                        throw error;
                                    const admitted = await lease(run, { kind: 'native-denied', call: evidence.id,
                                        message: evidence.message, name: evidence.name, arguments: {} }, signal);
                                    if (admitted.status !== 'ok' || signal.aborted) throw error;
                                }
                                const content = rejected ? '{"status":"rejected_by_user"}' : '{"status":"permission_denied"}';
                                await settleTool(run, evidence, content, false);
                                return { output: content };
                            }
                            if (signal.aborted || !['ask', 'allow'].includes(native.effects.get('edit')) ||
                                (await Promise.all(native.replies)).some(reply => reply.status !== 'ok') ||
                                typeof result.output !== 'string' || result.content !== undefined)
                                reject('native tool result unavailable');
                            await settleTool(run, evidence, result.output, true);
                            return result;
                        } finally {
                            run.native.delete(context.id);
                        }
                    };
                    return run.expected.autonomy.permissionEffect === 'allow' ? invoke() : serialApproval(run, invoke);
                };
            });
            for (const definition of definitions.values()) editor.add({
                name: definition.name,
                description: definition.description,
                input: definition.inputSchema,
                options: { codemode: false },
                async execute(input, context) {
                    const run = await sessionRun(context.sessionID);
                    const signal = context.signal;
                    if (!run?.catalogue.has(definition.name) || signal.aborted) reject('unqualified tool call');
                    const tool = await registerTool(run, context.id, context.messageID, definition.name, input);
                    const work = { kind: 'tool', call: tool.id, message: tool.message, name: tool.name, arguments: input };
                    const response = definition.name === approvedRead && run.expected.autonomy?.permissionEffect !== 'allow'
                        ? await approveRead(run, work, context)
                        : await lease(run, work, signal);
                    if (signal.aborted || !['ok', 'rejected', 'unsupported'].includes(response.status) ||
                        typeof response.content !== 'string' || typeof response.success !== 'boolean')
                        reject('tool result unavailable');
                    await settleTool(run, tool, response.content, response.success);
                    return { content: tool.content };
                }
            });
        });

        await ctx.rpc.register({
            id: 'sam-opencode-context',
            methods: Object.fromEntries(['inspect', 'configure', 'continue', 'fence-report', 'release-report', 'admit-late-background', 'delete-detached-session', 'poll', 'settle', 'child-poll', 'child-settle', ...Object.keys(jobs.methods), ...Object.keys(completion.methods)].map(name =>
                [name, { input: object, output: object }])),
            events: {}
        }, {
            ...jobs.methods,
            ...completion.methods,
            async inspect({ sessionId, inputId }) {
                const input = inputId ?? runs.get(sessionId)?.expected.inputId;
                const current = typeof sessionId === 'string' && typeof input === 'string'
                    ? await ctx.storage.get(receiptKey(sessionId, input)) : undefined;
                const baseNativeTools = [...nativeTools.keys()].every(name => name === 'patch' || wrappedNativeTools.has(name));
                return {
                    ...(processorTargets.length ? { processor: { contract: processorContract, targets: processorTargets } } : {}),
                    contract, epoch, steering: steeringContract, zenContext: zenContextContract, modelRequests: structuredClone(modelRequests),
                    backgroundJobs: jobs.qualification,
                    lateBackgroundResult: jobs.qualification ? 'opencode.background-result.v1' : null,
                    detachedCleanup: jobs.qualification && typeof ctx.session.remove === 'function' ? 'opencode.detached-session-cleanup.v1' : null,
                    autonomy: wrappedNativeTools.has(nativeWrite) ? autonomyContract : null,
                    autonomyRules: wrappedNativeTools.has(nativeWrite) && wrappedNativeTools.has(nativeEdit) ? rulesContract : null,
                    nativeTools: baseNativeTools ? nativeToolsContract : null,
                    nativeToolsWithPatch: baseNativeTools && wrappedNativeTools.has('patch') ? nativeToolsWithPatchContract : null,
                    patchFullAccessOnly: true,
                    subagents: baseNativeTools && wrappedSubagent && typeof ctx.session.releaseSubagentReport === 'function'
                        ? subagentsContract : null,
                    sessionContinuity: continuityContract,
                    restartEvidence: recoveryContract,
                    compaction: compactionContract,
                    attachments: attachmentsContract,
                    receipt: current ?? (typeof sessionId === 'string' && inputId === undefined
                        ? await ctx.storage.get(sessionId) ?? null : null)
                };
            },
            async configure({ catalogue }) {
                if (typeof catalogue !== 'string') reject('catalogue unavailable');
                const digest = sha256(catalogue);
                if (!catalogues.has(digest)) {
                    const next = JSON.parse(catalogue);
                    if (!Array.isArray(next) || new Set(next.map(tool => tool.name)).size !== next.length ||
                        next.some(tool => !/^(sam|apps|lifehub)_[a-z0-9_]+$/.test(tool.name) ||
                            typeof tool.description !== 'string' || tool.inputSchema?.type !== 'object'))
                        reject('invalid SAM catalogue');
                    for (const tool of next)
                        if (definitions.has(tool.name) && canonical(definitions.get(tool.name)) !== canonical(tool))
                            reject('SAM tool definition changed');
                    for (const tool of next) definitions.set(tool.name, tool);
                    catalogues.set(digest, new Map(next.map(tool => [tool.name, tool])));
                    reload = reload.then(() => ctx.tool.reload());
                }
                await reload;
                return { epoch, digest };
            },
            async continue({ sessionId, previous, authority, history }) {
                const session = await ctx.session.get({ sessionID: sessionId });
                const prior = runs.get(sessionId);
                if (!prior || prior.native.size ||
                    [...prior.work.values()].some(item => !['model', 'native-started'].includes(item.public.kind)) ||
                    canonical(prior.expected) !== canonical(previous) || canonical(session.metadata?.sam) !== canonical(previous) ||
                    !previous.continuity || authority.continuity?.previousInput !== previous.inputId ||
                    authority.epoch !== epoch || authority.catalogDigest !== previous.catalogDigest ||
                    authority.model !== previous.model || canonical(authority.modelRequest) !== canonical(previous.modelRequest) || canonical(authority.autonomy) !== canonical(previous.autonomy) ||
                    !Array.isArray(history?.users) || !Array.isArray(history?.answers) || !Array.isArray(history?.tools))
                    reject('previous SAM run is unavailable');
                verifyPermissions(prior, session);
                // SAM has already verified the previous idle and the closure receipt. A model
                // offer held before fetch can outlive its interrupted native step.
                // Withdraw these leases before arming the next input.
                prior.closed = true;
                for (const item of prior.work.values()) item.cancel();
                await prior.storage;
                armed.set(sessionId, { authority, history });
                return { epoch };
            },
            async ['fence-report']({ sessionId, authority, fence }) {
                const next = armed.get(sessionId);
                if (!next || canonical(next.authority) !== canonical(authority) ||
                    !authority.reportChildId || !authority.reportCallId ||
                    !Number.isSafeInteger(fence) || fence <= 0 || fence < (next.fence ?? 0))
                    reject('native report release is no longer armed');
                const session = await ctx.session.get({ sessionID: sessionId });
                if (canonical(session.metadata?.sam) !== canonical(authority) || armed.get(sessionId) !== next)
                    reject('native report authority changed');
                // Release claims this same entry before the native mutation. Replacing it
                // also rejects an old request that was awaiting its Session read.
                if (next.fence !== fence) armed.set(sessionId, { ...next, fence });
                return { epoch, notificationId: authority.inputId, fence };
            },
            async ['release-report']({ sessionId, authority, fence }) {
                const next = armed.get(sessionId);
                if (typeof ctx.session.releaseSubagentReport !== 'function' || !next || next.fence !== fence ||
                    canonical(next.authority) !== canonical(authority) ||
                    authority.subagentReportRelease !== 'sam.opencode-subagent-report-release/v1' ||
                    !authority.reportChildId || !authority.reportCallId || !authority.operation)
                    reject('native report is not admitted for continuation');
                const session = await ctx.session.get({ sessionID: sessionId });
                if (canonical(session.metadata?.sam) !== canonical(authority) || armed.get(sessionId) !== next)
                    reject('native report authority changed');
                armed.delete(sessionId);
                runs.delete(sessionId);
                const run = runFor(sessionId, authority);
                verifyPermissions(run, session);
                run.history = next.history;
                run.admitted = true;
                await ctx.session.releaseSubagentReport({ sessionID: sessionId, inboxID: authority.inputId });
                return { epoch, notificationId: authority.inputId };
            },
            async ['admit-late-background']({ sessionId, authority, ticket }) {
                const session = await ctx.session.get({ sessionID: sessionId });
                if (!authority?.lateBackgroundNotificationId || authority.epoch !== epoch ||
                    authority.continuity?.previousInput != null ||
                    canonical(session.metadata?.sam) !== canonical(authority) || runs.has(sessionId))
                    reject('late background result has no Run authority');
                const text = await jobs.lateInput(sessionId, authority, ticket);
                if (runs.has(sessionId)) reject('late background result already started');
                const run = runFor(sessionId, authority);
                verifyPermissions(run, session);
                run.admitted = true;
                await ctx.session.synthetic({ sessionID: sessionId, id: authority.inputId, text, resume: true,
                    metadata: { samInput: authority.inputId, samBackgroundNotification: authority.lateBackgroundNotificationId } });
                return { epoch, inputId: authority.inputId };
            },
            async ['delete-detached-session']({ sessionId, ticket }) {
                return jobs.deleteDetachedSession(sessionId, ticket);
            },
            async ['child-poll']({ sessionId, authority, childId, call }) {
                const child = await getChild(childId);
                const run = runs.get(childId);
                return { epoch, work: childSourceMatches(child, sessionId, authority, call) && run?.expected.child === call
                    ? [...run.work.values()].map(item => ({ ...item.public, input: run.expected.inputId })) : [] };
            },
            async ['child-settle']({ sessionId, authority, childId, call, ticket, result }) {
                const child = await getChild(childId);
                const run = runs.get(childId);
                const item = childSourceMatches(child, sessionId, authority, call) && run?.expected.child === call
                    ? run.work.get(ticket) : null;
                if (item) item.complete(result);
                return { epoch, accepted: !!item };
            },
            async poll({ sessionId, authority }) {
                const run = runs.get(sessionId);
                if (!run || run.expected.inputId !== authority.inputId) return { epoch, work: [] };
                runFor(sessionId, authority);
                return { epoch, work: [...run.work.values()].map(item => item.public) };
            },
            async settle({ sessionId, authority, ticket, result }) {
                const run = runs.get(sessionId);
                if (!run || run.expected.inputId !== authority.inputId) return { epoch, accepted: false };
                runFor(sessionId, authority);
                const item = run.work.get(ticket);
                if (!item) return { epoch, accepted: false };
                item.complete(result);
                return { epoch, accepted: true };
            }
        });

        const executeNative = async (run, name, action, execute, input, context, signal) => {
            if (signal.aborted) reject('native call withdrawn');
            const tool = await registerTool(run, context.id, context.messageID, name, input);
            const native = {
                signal, replies: [], effects: new Map(), actions: ['external_directory', action],
                command: name === 'shell' ? input.command : undefined, workdir: name === 'shell' ? input.workdir : undefined
            };
            const offer = (kind, args = {}) => lease(run, {
                kind, call: tool.id, message: tool.message, name, arguments: args
            }, signal);
            const admit = async (kind, args) => {
                if ((await offer(kind, args)).status !== 'ok' || signal.aborted) reject('native call withdrawn');
            };
            run.native.set(tool.id, native);
            try {
                const background = name === 'shell' && input.background === true && jobs.qualification &&
                    run.expected.backgroundJobs === jobs.qualification.contract && run.expected.continuity &&
                    run.expected.child === undefined && run.expected.reportChildId === undefined;
                await admit('native', background ? { background: true } : {});
                let result;
                try {
                    if (name === 'shell' && input.background === true) {
                        if (!background)
                            reject('background shell jobs are outside the SAM Run lifecycle');
                        tool.background = true;
                        await persist(run);
                    }
                    // Capture the native process ID before passing progress on to the Session.
                    // The tool keeps its original execution, permission checks and cancellation signal.
                    result = name === 'shell' ? await execute(input, {
                        ...context,
                        async progress(update) {
                            if (typeof update.shellID === 'string') {
                                tool.shellId = update.shellID;
                                tool.shellCommandDigest = sha256(input.command);
                                // OpenCode registers its cancellable job after this progress callback.
                                // Observing the ID must never hold the callback open on a SAM permit.
                                void persist(run).then(() => offer('native-started')).catch(() => {});
                            }
                            await context.progress(update);
                        }
                    }) : name === 'subagent' ? await execute(input, {
                        ...context,
                        async progress(update) {
                            const child = await ctx.session.get({ sessionID: update.sessionID });
                            const parent = await ctx.session.get({ sessionID: context.sessionID });
                            if (child.parentID !== context.sessionID || child.location.directory !== parent.location.directory ||
                                (run.expected.modelRequest === undefined ? child.model.providerID !== 'ollama' : !matchesModel(run.expected, child.model)) || canonical(child.permissions) !== canonical(parent.permissions))
                                reject('native child is outside the accepted context');
                            const history = await childHistory(child.id);
                            const entries = await ctx.session.instructions.entry.list({ sessionID: context.sessionID });
                            const value = run.contextText ?? entries.find(entry => entry.key === 'sam-context')?.value;
                            if (typeof value !== 'string' || sha256(value) !== run.expected.contextDigest)
                                reject('delegated context changed');
                            await admit('subagent-grant', { childSession: child.id });
                            const priorAuthority = run.expected.child === undefined ? null : await getChild(run.sessionId);
                            const authority = { parent: parent.id, rootSession: priorAuthority?.rootSession ?? parent.id,
                                root: priorAuthority?.root ?? run.expected, call: tool.id,
                                directory: child.location.directory, variant: child.model.variant ?? null, context: value, history,
                                promptDigest: sha256(input.sessionID ? input.prompt : 'You are a subagent spawned by another session.\n' + input.prompt) };
                            await ctx.storage.set(childKey(child.id), authority);
                            children.set(child.id, authority);
                            await context.progress(update);
                        }
                    }) : await execute(input, context);
                } catch (error) {
                    if (signal.aborted || native.withdrawn) throw error;
                    const refusal = error.error ?? error.cause?.error;
                    const denied = refusal?._tag === 'Permission.BlockedError';
                    const result = await offer(denied ? 'native-denied' : 'native-result');
                    if (result.status !== 'ok' || signal.aborted) throw error;
                    tool.nativeError = denied ? 'permission.rejected' : 'error';
                    tool.nativeReturned = true;
                    await persist(run);
                    throw error;
                }
                if (signal.aborted || native.withdrawn) reject('native result withdrawn');
                if (name !== 'shell' && !native.effects.has(action)) reject('native permission observation unavailable');
                if ((await Promise.all(native.replies)).some(reply => reply.status !== 'ok'))
                    reject('native permission reply unconfirmed');
                if (name === 'shell' && (result.metadata?.status !== (tool.background ? 'running' : 'completed') || !tool.shellId))
                    reject('native shell completion unconfirmed');
                await admit('native-result');
                tool.nativeReturned = true;
                tool.success = name !== 'shell' || tool.background === true || result.output.exitCode === 0;
                // The live shell lookup need not survive this process. Keep the stock tool's
                // exit facts, without its output or command, before letting OpenCode use its result.
                if (name === 'shell' && Number.isInteger(result.metadata.exit) &&
                    result.metadata.exit === result.output.exitCode &&
                    !result.metadata.timeout && !result.metadata.killed && result.metadata.signal === undefined)
                    tool.shellExit = result.metadata.exit;
                await persist(run);
                return result;
            } finally {
                run.native.delete(tool.id);
            }
        };

        const allowsNativeTool = (run, name) => {
            const policy = run.expected.autonomy;
            if (!policy) return false;
            if (name === 'subagent') return run.expected.subagents === subagentsContract;
            if (name === 'patch') return usesPatch(run) && policy.selection === 'full_access';
            const native = usesNativeTools(run) ? nativeTools.has(name) :
                name === nativeWrite || policy.version === 2 && name === nativeEdit;
            if (!native) return false;
            const action = nativeTools.get(name);
            // OpenCode omits a tool when the last rule for its action denies every resource.
            const rule = policy.version === 2 ? JSON.parse(policy.rules).findLast(rule => rule.action === action) : null;
            return rule?.resource !== '*' || rule.effect !== 'deny';
        };
        const allowsTool = (run, name) => run.catalogue.has(name) || allowsNativeTool(run, name);

        await ctx.session.hook('prompt', async event => {
            const session = await ctx.session.get({ sessionID: event.sessionID });
            const child = session.parentID ? await getChild(event.sessionID) : null;
            if (event.expectedExecution && (session.metadata?.sam || child)) {
                const expected = session.metadata?.sam;
                const run = runs.get(event.sessionID);
                const authority = event.metadata?.samSteering;
                if (session.parentID || !run?.admitted || run.closed || !expected?.continuity ||
                    expected.reportChildId !== undefined || expected.lateBackgroundNotificationId !== undefined ||
                    expected.epoch !== epoch || canonical(run.expected) !== canonical(expected) ||
                    !matchesModel(expected, session.model) || event.delivery !== 'steer' ||
                    event.expectedExecution.rootMessageID !== expected.inputId ||
                    !steeringMessage.test(event.messageID) || event.messageID !== 'msg_steer_' + authority?.operation ||
                    authority?.epoch !== epoch || authority.inputId !== expected.inputId ||
                    event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length) {
                    // Native admission rejects a bound prompt whose hook changes delivery.
                    // A refused request can never enter the ordinary queue.
                    event.delivery = 'queue';
                    return;
                }
                verifyPermissions(run, session);
                event.metadata = undefined;
                return;
            }
            if (child) {
                if (child.parent !== session.parentID || child.root.epoch !== epoch || child.inputId !== undefined ||
                    sha256(event.prompt.text) !== child.promptDigest || event.prompt.files?.length)
                    reject('child prompt is outside the accepted delegation');
                child.inputId = event.messageID;
                await ctx.storage.set(childKey(event.sessionID), child);
                children.set(event.sessionID, child);
                const { reportChildId, reportCallId, attachmentManifest, compaction, ...root } = child.root;
                const expected = { ...root, child: child.call, inputId: event.messageID, inputDigest: child.promptDigest,
                    model: session.model.id, continuity: {} };
                runs.delete(event.sessionID);
                const run = runFor(event.sessionID, expected);
                verifyPermissions(run, session);
                run.contextText = child.context;
                run.history = child.history;
                run.admitted = true;
                return;
            }
            const expected = session.metadata?.sam;
            if (!expected?.continuity) return;
            if (expected.reportChildId !== undefined) reject('report authority requires native release');
            if (expected.lateBackgroundNotificationId !== undefined) reject('late background result requires controlled admission');
            if (expected.epoch !== epoch) reject('session authority belongs to a different process');
            if (event.messageID !== expected.inputId || event.metadata?.samInput !== expected.inputId ||
                sha256(event.prompt.text) !== expected.inputDigest || event.delivery !== 'queue')
                reject('prompt does not match SAM authority');
            verifyPromptFiles(expected, event.prompt.files ?? []);
            if (expected.continuity.previousInput) {
                const next = armed.get(event.sessionID);
                if (!next || canonical(next.authority) !== canonical(expected)) reject('SAM run is not admitted for continuation');
                runs.delete(event.sessionID);
                const run = runFor(event.sessionID, expected);
                run.history = next.history;
                armed.delete(event.sessionID);
            } else if (runs.has(event.sessionID)) reject('SAM run already started');
            const run = runFor(event.sessionID, expected);
            run.admitted = true;
        });

        const samContextBlock = /<context key="sam-context">\n([\s\S]*?)\n<\/context>/g;
        await ctx.tool.hook('execute.before', async event => {
            const run = await sessionRun(event.sessionID);
            if (run && !allowsTool(run, event.tool)) {
                const step = run.steps.at(-1);
                if (step?.responseObserved && !run.closed)
                    run.rejectedOffer ??= { id: event.id, message: event.messageID, name: event.tool, step: step.sequence };
                reject(outsideCatalogue);
            }
            if (run?.incompleteOffers.has(event.id)) reject('duplicate tool attempt');
            if (run?.catalogue.has(event.tool)) {
                if (run.attempts.has(event.id)) reject('duplicate tool attempt');
                run.attempts.set(event.id, { message: event.messageID, name: event.tool, input: structuredClone(event.input),
                    step: run.steps.at(-1)?.sequence });
            }
        });

        const applyContext = async (run, event) => {
            const entries = await ctx.session.instructions.entry.list({ sessionID: event.sessionID });
            const value = run.contextText ?? entries.find(entry => entry.key === 'sam-context')?.value;
            if (typeof value !== 'string' || sha256(value) !== run.expected.contextDigest)
                reject('SAM context entry does not match accepted run');
            const block = { type: 'text', text: `<context key="sam-context">\n${value}\n</context>` };
            if (requestScope(run.expected)) {
                event.system = [block];
                event.messages = event.messages.filter(message => message.role !== 'system' && message.role !== 'developer');
                return;
            }
            event.system = event.system.map(part => ({ ...part, text: part.text.replace(samContextBlock, '') }))
                .filter(part => part.text.trim());
            // OpenCode lowers chronological instruction updates into user messages for Ollama.
            event.messages = event.messages.flatMap(message => {
                if (message.role !== 'system') return [message];
                const content = (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content)
                    .filter(part => typeof part.text !== 'string' || !part.text.includes('The context under "sam-context" changed'));
                return content.length ? [{ ...message, content }] : [];
            });
            event.system.push(block);
        };
        const checkpointProof = text => {
            const match = /^<conversation-checkpoint>\n[\s\S]*?\n<summary>\n([\s\S]*?)\n<\/summary>\n[\s\S]*<\/conversation-checkpoint>$/.exec(text);
            return match ? sha256(match[1]) : null;
        };
        const textOf = message => typeof message.content === 'string' ? message.content :
            message.content?.every(part => part.type === 'text') ? message.content.map(part => part.text).join('') : null;
        const visibleText = parts => parts.filter(part => part.type === 'text').map(part => part.text).join('');
        const assistantText = messages => messages.filter(message => message.role === 'assistant')
            .map(message => ({ id: message.id, text: visibleText(partsOf(message)) }))
            .filter(message => message.text);

        const acceptedZenAssistant = async (run, messages) => {
            const projected = assistantText(messages);
            if (!projected.length) return [];
            const assistants = new Map((await readContext(run.sessionId)).filter(message => message.type === 'assistant')
                .map(message => [message.id, message]));
            for (const item of projected) {
                const native = assistants.get(item.id);
                if (!native) reject('cloud assistant context has no native source');
                const text = visibleText(native.content);
                if (item.text !== text && (!(native.error || native.finish === undefined) || !text.startsWith(item.text)))
                    reject('cloud assistant context differs from its native source');
            }
            return projected.map(item => sha256(item.text));
        };

        const verifyZenTranscript = (run, messages, compacting) => {
            if (!Array.isArray(messages) || messages.some(message => !['system', 'user', 'assistant', 'tool'].includes(message?.role) ||
                Array.isArray(message.content) && message.content.some(part => part?.type !== 'text')))
                reject('cloud input modality is not qualified');
            const system = messages.filter(message => message.role === 'system');
            const text = system.length === 1 && textOf(system[0]);
            const context = typeof text === 'string' ? [...text.matchAll(samContextBlock)] : [];
            if (context.length !== 1 || context[0][0] !== text || sha256(context[0][1]) !== run.expected.contextDigest)
                reject('cloud system context exceeds the accepted SAM context');
            const observed = assistantText(messages).map(item => sha256(item.text));
            if (!compacting) {
                if (canonical(observed) !== canonical(run.zenAssistant))
                    reject('cloud assistant context changed');
            } else {
                // Native compaction may select a smaller transcript before adding its summary prompt.
                let index = 0;
                for (const digest of run.zenCompactionAssistant ?? [])
                    if (observed[index] === digest) index++;
                if (index !== observed.length) reject('cloud compaction assistant context changed');
            }
        };
        const prepareCheckpoint = (run, event) => {
            const last = run.compactions.at(-1);
            if (!last && !run.history.checkpoint) return;
            const prefix = event.messages.find(message => message.id === (last?.id ?? run.history.checkpoint?.id));
            if (!prefix) reject('compaction checkpoint unavailable');
            const text = textOf(prefix);
            const summaryDigest = text && checkpointProof(text);
            if (!summaryDigest) reject('compaction checkpoint malformed');
            if (last && !last.summaryDigest) reject('compaction result was not observed');
            if (summaryDigest !== (last?.summaryDigest ?? run.history.checkpoint.summaryDigest))
                reject('compaction checkpoint changed');
            run.checkpointDigest = sha256(text);
        };

        await ctx.session.hook('context', async event => {
            const run = await sessionRun(event.sessionID);
            if (!run) return;
            const cloud = requestScope(run.expected);
            if (cloud || run.expected.continuity) await applyContext(run, event);
            if (run.expected.continuity) {
                historicalMessages(run, event);
                const last = run.compactions.at(-1);
                if (last && !last.summaryDigest) {
                    const transcript = await readContext(event.sessionID);
                    const checkpoint = transcript.find(message => message.type === 'compaction');
                    if (checkpoint?.id !== last.id || checkpoint.status !== 'completed' ||
                        checkpoint.reason !== 'auto' || checkpoint.native !== undefined || !last.responseObserved ||
                        !matchesModel(run.expected, checkpoint.model) ||
                        checkpoint.model?.variant !== run.compactionModel?.variant || !checkpoint.summary?.trim())
                        reject('compaction result was not confirmed');
                    last.summaryDigest = sha256(checkpoint.summary);
                }
                if (last) {
                    // OpenCode moves earlier entries into checkpoint text. Keep this Run's exact
                    // input/results as ordinary messages. Never rebuild an older Run from summary.
                    const index = event.messages.findIndex(message => message.id === last.id);
                    if (index < 0 || !run.currentPrefix?.length) reject('current SAM window unavailable');
                    const checkpoint = event.messages[index];
                    const text = textOf(checkpoint);
                    const compact = text?.replace(/\n\n<recent-context>\n[\s\S]*\n<\/recent-context>(?=\n<\/conversation-checkpoint>$)/, '');
                    if (!compact || checkpointProof(compact) !== last.summaryDigest) reject('compaction checkpoint malformed');
                    // A single checkpoint from the real native window, with the duplicate
                    // recent rendering removed; preserved structured tool facts follow it.
                    event.messages[index] = { ...checkpoint, content: [{ type: 'text', text: compact }] };
                    event.messages.splice(index + 1, 0, ...run.currentPrefix);
                }
                prepareCheckpoint(run, event);
                if (last) {
                    last.checkpointDigest = run.checkpointDigest;
                    run.history = { users: [], answers: [], tools: [] };
                }
                const users = event.messages.filter(message => message.role === 'user');
                const current = users.findIndex(message => matchesInput(message, run.expected));
                if (current < 0 || users.filter(message => matchesInput(message, run.expected)).length !== 1)
                    reject('current SAM input not available');
                const suffix = users.slice(current + 1);
                const missing = [...run.attempts].filter(([id]) => !run.tools.has(id) && !run.argumentRejections.has(id));
                if (suffix.length || missing.length) {
                    const transcript = await readContext(event.sessionID);
                    let previousContinuation = -1;
                    const continuations = [];
                    for (const message of suffix) {
                        const index = transcript.findIndex(item => item.id === message.id);
                        const native = transcript[index];
                        if (index <= previousContinuation || typeof native?.text !== 'string' || textOf(message) !== native.text)
                            reject('unconfirmed synthetic continuation');
                        const digest = sha256(native.text);
                        const binding = native.metadata?.opencodeBoundSteering;
                        const steering = native.type === 'user' && steeringMessage.test(native.id) &&
                            binding?.sessionID === run.sessionId && binding.messageID === native.id &&
                            binding.execution?.rootMessageID === run.expected.inputId &&
                            typeof binding.execution.ownerToken === 'string' && binding.execution.ownerToken.length > 0 &&
                            binding.digest === digest;
                        const background = !steering &&
                            await jobs.continuation(run.sessionId, run.expected, native, run.tools);
                        if (!steering && !background && !isLengthContinuation(transcript, index))
                            reject('unconfirmed synthetic continuation');
                        previousContinuation = index;
                        continuations.push({ id: message.id, digest, background });
                    }
                    run.continuations = continuations;
                    for (const [id, attempt] of missing) {
                        const message = transcript.find(item => item.id === attempt.message && item.type === 'assistant');
                        const part = message?.content.find(part => part.type === 'tool' && part.id === id);
                        const state = part?.state;
                        if (!attempt.step || !run.steps[attempt.step - 1]?.responseObserved || part?.name !== attempt.name ||
                            part.executed !== false || !Number.isSafeInteger(part.time?.ran) ||
                            !Number.isSafeInteger(part.time?.completed) || state?.status !== 'error' ||
                            state.error?.type !== 'tool.execution' ||
                            !state.error.message?.startsWith(`Invalid arguments for tool "${attempt.name}":`) ||
                            canonical(state.input) !== canonical(attempt.input))
                            reject('unconfirmed pre-execution tool error');
                        const content = JSON.stringify({ error: state.error, content: state.content ?? [] });
                        run.argumentRejections.set(id, {
                            id, message: attempt.message, name: attempt.name, step: attempt.step,
                            argumentsDigest: sha256(JSON.stringify(state.input)), replayInput: canonical(state.input),
                            resultDigest: sha256(content), nativeError: state.error.type, success: false, content
                        });
                        await persist(run);
                    }
                } else run.continuations = [];
                if (run.expected.attachmentManifest !== undefined) verifyAttachmentContext(run, users[current]);
            }
            if (cloud) run.zenAssistant = await acceptedZenAssistant(run, event.messages);
            if (run.expected.autonomy && !wrappedNativeTools.has(nativeWrite) ||
                run.expected.autonomy?.version === 2 && !wrappedNativeTools.has(nativeEdit))
                reject('native file policy is unavailable');
            // OpenCode 2.3.0's model hook hides the already registered patch tool
            // for non-GPT models. Restore its JSON definition for qualified SAM Runs.
            // OpenCode resolves this name back to the original tool and validates its input.
            if (allowsNativeTool(run, 'patch') && patchDescription && !event.tools.patch)
                event.tools.patch = { description: patchDescription, input: structuredClone(patchInput) };
            for (const name of Object.keys(event.tools))
                if (!allowsTool(run, name)) delete event.tools[name];
            const candidates = [...nativeTools.keys(), ...(run.expected.child === undefined || event.tools.subagent ? ['subagent'] : [])];
            const expectedNative = candidates.filter(name => allowsNativeTool(run, name));
            if (expectedNative.some(name => !(name === 'subagent' ? wrappedSubagent : wrappedNativeTools.has(name)) || !event.tools[name]))
                reject('native tool definition unavailable');
            run.nativeDefinitions = new Map(expectedNative.map(name => [name, event.tools[name]]));
        });

        const readContext = async sessionId => {
            const value = await ctx.session.context({ sessionID: sessionId });
            return Array.isArray(value) ? value : value.data;
        };

        const verifyIncompleteOffers = async (run, calls, results) => {
            const previous = run.steps.at(-1);
            if (!previous?.responseObserved) return false;
            if ([...calls.keys()].some(id => !run.tools.has(id) && !run.incompleteOffers.has(id))) {
                const transcript = await readContext(run.sessionId);
                const input = transcript.findIndex(message => message.id === run.expected.inputId);
                const assistants = transcript.slice(input + 1).filter(message => message.type === 'assistant');
                const last = assistants.at(-1);
                if (input >= 0 && assistants.length === previous.sequence && last?.finish === 'length' && last.error === undefined) {
                    for (const part of last.content) {
                        const state = part.state;
                        if (part.type !== 'tool' || part.executed !== false || !part.time || part.time.ran !== undefined ||
                            !Number.isSafeInteger(part.time.completed) || state?.status !== 'error' ||
                            state.error?.type !== 'tool.input-incomplete' || typeof state.error.message !== 'string' ||
                            canonical(state.input) !== '{}' ||
                            !allowsTool(run, part.name) || run.tools.has(part.id) || run.attempts.has(part.id) ||
                            run.incompleteOffers.has(part.id))
                            continue;
                        run.incompleteOffers.set(part.id, {
                            id: part.id, message: last.id, name: part.name, step: previous.sequence,
                            argumentsDigest: sha256('{}'),
                            resultDigest: sha256(JSON.stringify({ error: state.error, content: state.content ?? [] }))
                        });
                    }
                }
            }
            for (const offer of run.incompleteOffers.values()) {
                const call = calls.get(offer.id);
                const result = results.get(offer.id);
                if (run.tools.has(offer.id) || call?.name !== offer.name ||
                    offer.argumentsDigest !== sha256(canonical(JSON.parse(call.arguments))) ||
                    typeof result !== 'string' || offer.resultDigest !== sha256(result))
                    reject('incomplete tool offer replay is inconsistent');
                calls.delete(offer.id);
                results.delete(offer.id);
            }
            return [...run.incompleteOffers.values()].some(offer => offer.step === previous.sequence);
        };

        const childHistory = async id => {
            const transcript = await readContext(id);
            const prior = runs.get(id);
            const history = { users: [], answers: [], tools: [] };
            for (const item of transcript) {
                if (item.type === 'user' && typeof item.text === 'string') history.users.push(sha256(item.text));
                else if (item.type === 'assistant') {
                    const answer = item.content.filter(part => part.type === 'text').map(part => part.text).join('');
                    if (answer) history.answers.push(sha256(answer));
                    for (const part of item.content.filter(part => part.type === 'tool')) {
                        const proof = prior?.tools.get(part.id) ?? prior?.argumentRejections.get(part.id) ?? prior?.incompleteOffers.get(part.id) ??
                            prior?.history.tools.find(tool => tool.id === part.id);
                        if (!proof || proof.name !== part.name ||
                            (proof.replayInput !== undefined ? proof.replayInput !== canonical(part.state.input) :
                                proof.argumentsDigest ? proof.argumentsDigest !== sha256(canonical(part.state.input)) :
                                canonical(proof.input) !== canonical(part.state.input)))
                            reject('child history tool identity changed');
                        const result = part.state.status === 'error' && part.state.error
                            ? JSON.stringify({ error: part.state.error, content: part.state.content ?? [] })
                            : part.state.status === 'completed' && part.state.content?.every(content => content.type === 'text')
                                ? part.state.content.map(content => content.text).join('\n') : null;
                        if (typeof result !== 'string' || !(proof.resultDigest || proof.nativeReturned) ||
                            proof.resultDigest && proof.resultDigest !== sha256(result))
                            reject('child history is unconfirmed');
                        history.tools.push({ id: part.id, name: part.name, input: part.state.input, resultDigest: sha256(result) });
                    }
                } else if (isLengthContinuation(transcript, transcript.indexOf(item))) history.users.push(sha256(item.text));
                else if (item.type !== 'idle' && item.type !== 'system') reject('child history is unconfirmed');
            }
            return history;
        };

        await ctx.session.hook('compaction', async event => {
            const run = await sessionRun(event.sessionID);
            if (!run) return;
            const previous = run.compactions.at(-1);
            const lastStep = run.steps.at(-1);
            if (run.expected.compaction !== compactionContract || !run.admitted || run.closed ||
                run.pending || run.native.size || run.work.size ||
                previous && (!previous.summaryDigest || previous.afterStep === run.steps.length) ||
                lastStep && (!lastStep.responseObserved || ![...run.tools.values()].some(tool => tool.step === lastStep.sequence)) ||
                !matchesModel(run.expected, event.model))
                reject('compaction is outside the qualified run');
            const transcript = await readContext(event.sessionID);
            const checkpoint = transcript.at(-1);
            if (checkpoint?.type !== 'compaction' || checkpoint.reason !== 'auto' || checkpoint.status !== 'running')
                reject('compaction has no active native boundary');
            await applyContext(run, event);
            historicalMessages(run, event);
            const index = event.messages.findIndex(message => matchesInput(message, run.expected));
            const previousIndex = previous ? event.messages.findIndex(message => message.id === previous.id) : -1;
            if (previous ? previousIndex < 0 : index < 0 || sha256((run.expected.attachmentManifest === undefined
                ? textOf(event.messages[index]) : primaryText(event.messages[index])) ?? '') !== run.expected.inputDigest)
                reject('compaction input is unavailable');
            const current = previous ? event.messages.slice(previousIndex + 1) : event.messages.slice(index);
            // Keep the qualified current input for subsequent primary steps, but send only
            // original user text to the out-of-band summarizer. Preserve media asset objects.
            run.currentPrefix = [...(run.currentPrefix ?? []), ...current];
            if (index >= 0 && run.expected.attachmentManifest !== undefined) {
                verifyAttachmentContext(run, event.messages[index]);
                event.messages[index] = { ...event.messages[index], content: partsOf(event.messages[index]).slice(0, 1) };
            }
            if (requestScope(run.expected)) run.zenCompactionAssistant = await acceptedZenAssistant(run, event.messages);
            run.compactionId = checkpoint.id;
            run.compactionModel = event.model;
            for (const name of Object.keys(event.tools)) delete event.tools[name];
        });

        await ctx.session.hook('http.request', async event => {
            const session = await ctx.session.get({ sessionID: event.sessionID });
            const run = await sessionRun(event.sessionID);
            if (!run) return;
            const expected = run.expected;
            const permissionEffect = verifyPermissions(run, session);
            const address = new URL(event.request.url);
            const compacting = event.kind === 'compaction';
            const scope = requestScope(expected);
            const local = localRequestScope(expected);
            const recipient = local ?? scope;
            const recipientMatches = recipient ? event.request.url === recipient.endpoint :
                address.origin === 'http://127.0.0.1:11434' && address.pathname === '/v1/chat/completions' && !address.search;
            if (run.closed || run.pending || !(event.kind === 'primary' || compacting && run.compactionId) ||
                !matchesModel(expected, event.model) || !recipientMatches || event.request.method !== 'POST')
                reject('request is outside the qualified scope');
            if (local) {
                event.request.headers.set('x-sam-inference-role', 'agent');
                event.request.headers.set('x-sam-correlation-id', event.sessionID);
            }
            run.pending = true;
            try {
                if (run.rejectedOffer) {
                    run.catalogueRejection = run.rejectedOffer;
                    await persist(run);
                    reject(outsideCatalogue);
                }
                const bytes = Buffer.from(await event.request.clone().arrayBuffer());
                const payload = JSON.parse(bytes.toString('utf8'));
                if (recipient && (payload.stream !== true || payload.model !== recipient.modelId))
                    reject('qualified model streaming request changed');
                if (scope) verifyZenTranscript(run, payload.messages, compacting);
                const exact = payload.messages.flatMap(message =>
                    typeof message.content === 'string' ? [...message.content.matchAll(samContextBlock)] : []);
                const users = payload.messages.filter(message => message.role === 'user');
                if (compacting) {
                    // Only the hook for the active native compaction may admit a tool-free Ollama request.
                    // No automatic retry of an ambiguous dispatch; the native template nudge also needs separate evidence.
                    if (run.compactions.some(fact => !fact.summaryDigest) ||
                        (event.model.variant ?? 'default') !== (session.model.variant ?? 'default') ||
                        exact.length !== 1 || sha256(exact[0][1]) !== expected.contextDigest ||
                        payload.model !== expected.model || payload.tools?.length ||
                        !String(users.at(-1)?.content).includes('Do not continue the task or call tools.'))
                        reject('compaction request is outside the qualified scope');
                    const fact = { afterStep: run.steps.length, requestDigest: sha256(bytes), responseObserved: false,
                        id: run.compactionId };
                    const allowed = await lease(run, { kind: 'compaction', arguments: {} }, event.request.signal);
                    if (allowed.status !== 'ok' || run.closed || event.request.signal.aborted)
                        reject('compaction request withdrawn');
                    run.recovery = undefined;
                    run.compactions.push(fact);
                    run.requests.set(event.request, fact);
                    await persist(run);
                    return;
                }
                const first = users[0];
                const input = run.checkpointDigest ? users.slice(1) : users;
                const currentInput = input[run.history.users.length];
                if (run.checkpointDigest && (!first || sha256(first.content) !== run.checkpointDigest))
                    reject('compaction checkpoint did not survive serialization');
                const functions = (payload.tools ?? []).map(tool => tool.function);
                const names = functions.map(tool => tool?.name);
                const expectedCount = run.catalogue.size + run.nativeDefinitions.size;
                if (exact.length !== 1 || sha256(exact[0][1]) !== expected.contextDigest || payload.model !== expected.model
                    || input.length !== run.history.users.length + 1 + run.continuations.length ||
                    run.continuations.some((item, index) => sha256(input[run.history.users.length + 1 + index]?.content ?? '') !== item.digest) ||
                    (expected.attachmentManifest === undefined
                        ? typeof currentInput?.content !== 'string' || sha256(currentInput.content) !== expected.inputDigest
                        : !verifyAttachmentWire(run, currentInput?.content))
                    || run.history.users.some((digest, index) => sha256(input[index].content) !== digest)
                    || names.length !== expectedCount || new Set(names).size !== expectedCount
                    || functions.some(tool => {
                        const native = run.nativeDefinitions.get(tool?.name);
                        if (native)
                            return tool.description !== native.description || canonical(tool.parameters) !== canonical(native.input);
                        const registered = run.catalogue.get(tool?.name);
                        return !registered || tool.description !== registered.description ||
                            canonical(tool.parameters) !== canonical(registered.inputSchema);
                    }))
                    reject('context, input or tool catalogue did not survive serialization');

                // Only answers before the current input can satisfy native transcript replay.
                let answerIndex = 0;
                for (const message of payload.messages.slice(0, payload.messages.lastIndexOf(currentInput)))
                    if (message.role === 'assistant' && typeof message.content === 'string' &&
                        sha256(message.content) === run.history.answers[answerIndex]) answerIndex++;
                if (answerIndex !== run.history.answers.length) reject('previous assistant text is absent');

                const calls = new Map();
                const results = new Map();
                for (const message of payload.messages) {
                    for (const call of message.tool_calls ?? []) {
                        if (calls.has(call.id)) reject('duplicate tool call on wire');
                        calls.set(call.id, call.function);
                    }
                    if (message.role === 'tool') {
                        if (results.has(message.tool_call_id)) reject('duplicate tool result on wire');
                        results.set(message.tool_call_id, message.content);
                    }
                }
                for (const prior of run.history.tools) {
                    const call = calls.get(prior.id);
                    if (call?.name !== prior.name || canonical(JSON.parse(call.arguments)) !== canonical(prior.input) ||
                        typeof results.get(prior.id) !== 'string' || sha256(results.get(prior.id)) !== prior.resultDigest)
                        reject('previous tool replay is incomplete or inconsistent');
                    calls.delete(prior.id);
                    results.delete(prior.id);
                }
                for (const rejection of run.argumentRejections.values()) {
                    const call = calls.get(rejection.id);
                    if (call?.name !== rejection.name || results.get(rejection.id) !== rejection.content ||
                        canonical(JSON.parse(call.arguments)) !== rejection.replayInput)
                        reject('tool argument rejection replay is inconsistent');
                    calls.delete(rejection.id);
                    results.delete(rejection.id);
                }
                const previous = run.steps.at(-1);
                const incomplete = await verifyIncompleteOffers(run, calls, results);
                if (previous && (!previous.responseObserved ||
                    ![...run.tools.values()].some(tool => tool.step === previous.sequence) && !incomplete &&
                    ![...run.argumentRejections.values()].some(tool => tool.step === previous.sequence) &&
                    run.continuations.length <= (previous.continuationCount ?? 0)))
                    reject('continuation has no new tool results');
                if (calls.size !== run.tools.size || results.size !== run.tools.size ||
                    [...run.tools.values()].some(tool => {
                        const call = calls.get(tool.id);
                        const content = results.get(tool.id);
                        // OpenCode truncates and serializes native output after execute() returns.
                        // SAM also checks this exact digest against the native Session inventory.
                        if (tool.nativeReturned && tool.resultDigest === undefined && typeof content === 'string') {
                            tool.content = content;
                            tool.resultDigest = sha256(content);
                            tool.success ??= false;
                        }
                        if (!tool.resultDigest || call?.name !== tool.name || content !== tool.content)
                            return true;
                        // OpenCode 2.3 repairs arguments before execute and replays the original model call.
                        const digest = sha256(canonical(JSON.parse(call.arguments)));
                        if (scope && digest !== tool.argumentsDigest) return true;
                        tool.replayArgumentsDigest ??= digest;
                        return digest !== tool.replayArgumentsDigest;
                    })) reject('tool replay is incomplete or inconsistent');

                const sequence = run.steps.length + 1;
                const step = { sequence, continuationCount: run.continuations.length, requestDigest: sha256(bytes), results: [...results.keys()], responseObserved: false,
                    permissionEffect, checkpointDigest: run.checkpointDigest,
                    attachmentDigest: expected.attachmentManifest === undefined ? undefined : sha256(expected.attachmentManifest) };
                const args = step.attachmentDigest === undefined ? { sequence } : { sequence, attachmentDigest: step.attachmentDigest };
                const reports = run.continuations.filter(item => item.background).map(({ id, digest }) => ({ id, digest }));
                if (reports.length) args.backgroundReports = reports;
                const authorized = await lease(run, { kind: 'model', arguments: args }, event.request.signal);
                if (authorized.status !== 'ok' || run.closed || event.request.signal.aborted) reject('model request withdrawn');
                run.recovery = undefined;
                run.steps.push(step);
                run.requests.set(event.request, step);
                await persist(run);
            } catch (error) {
                run.closed = true;
                throw error;
            } finally {
                run.pending = false;
            }
        });
        await ctx.session.hook('http.response', async event => {
            const run = runs.get(event.sessionID);
            if (!run) return;
            const step = run.requests.get(event.request);
            if (!step) reject('model response has no matching request');
            if (requestScope(run.expected)) {
                step.httpStatus = event.response.status;
                if (!event.response.ok) {
                    if (step.httpStatus === 429) step.retryAfterSeconds = retryAfterSeconds(event.response.headers);
                    await persist(run);
                    return;
                }
            } else if (!event.response.ok) reject('model response has no matching request');
            step.responseObserved = true;
            await persist(run);
        });
        await ctx.session.hook('experimental.idle', async ({ sessionID, background }) => {
            const run = runs.get(sessionID);
            if (!run?.expected.continuity || run.closed || run.pending || background.length ||
                run.native.size || run.work.size || !run.steps.length ||
                run.steps.some(step => !step.responseObserved) ||
                [...run.tools.values()].some(tool => !tool.resultDigest)) return;
            // Runs only before normal idle. This is not a terminal outcome. Recovery also
            // needs the durable idle record and a closed, matching OpenCode transcript.
            const session = await ctx.session.get({ sessionID });
            if (canonical(session.metadata?.sam) !== canonical(run.expected) ||
                !Number.isSafeInteger(session.time?.busy)) return;
            run.recovery = { contract: recoveryContract, busySince: session.time.busy };
            await persist(run);
        });
        await ctx.session.hook('retry', async event => {
            const session = await ctx.session.get({ sessionID: event.sessionID });
            if (session.metadata?.sam) event.decision = { retry: false };
        });
    }
};
