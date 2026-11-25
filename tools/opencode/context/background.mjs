import { createHash, createPublicKey, verify } from 'node:crypto';

export const contract = 'sam.opencode-background-jobs/v1';

const engineContract = 'sam.opencode-background-engine/v1';
const admissionContract = 'sam.opencode-background-admission/v1';
const actions = ['release', 'stop'];
const functions = ['read', 'output', 'reports', ...actions];
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value) &&
    value !== '00000000-0000-0000-0000-000000000000';
const id = (value, prefix) => typeof value === 'string' && value.length <= 160 &&
    value.startsWith(prefix) && /^[a-zA-Z0-9_]+$/.test(value);
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const base64url = (value, max) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
// Native Effect values can contain class instances or absent properties. RPC expects wire JSON.
const wire = value => JSON.parse(JSON.stringify(value));
const unavailable = () => { throw new Error('SAM OpenCode: background operation unavailable'); };
const denied = () => { throw new Error('SAM OpenCode: background authorization rejected'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const releaseKey = (sessionId, inputId, notificationId) => `background-release/${sessionId}/${inputId}/${notificationId}`;

function publicKey(value) {
    if (!value) return null;
    try {
        const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null;
    } catch {
        return null;
    }
}

export function background(ctx, epoch) {
    const backend = process.env.SAM_OPENCODE_BACKGROUND_AUDIENCE;
    const key = publicKey(process.env.SAM_OPENCODE_BACKGROUND_PUBLIC_KEY);
    const engine = ctx.shell?.background;
    const supported = ctx.app?.version === '2.3.0' && engine?.contract === engineContract &&
        label(engine.directory) && label(backend) && key && functions.every(name => typeof engine[name] === 'function');

    const qualification = supported ? { contract, engine: engineContract, admission: admissionContract,
        directory: engine.directory, backendNamespace: backend,
        signerDigest: digest(key.export({ format: 'der', type: 'spki' })) } : null;
    const owners = new Map();
    const delivering = new Map();

    function signedPayload(ticket) {
        if (!qualification || !base64url(ticket?.payload, 32768) || !base64url(ticket?.signature, 86)) denied();
        const payload = Buffer.from(ticket.payload, 'base64url');
        const signature = Buffer.from(ticket.signature, 'base64url');
        if (signature.length !== 64 || !verify('sha256', payload, { key, dsaEncoding: 'ieee-p1363' }, signature)) denied();
        try { return JSON.parse(payload.toString('utf8')); }
        catch { denied(); }
    }

    function grant(action, ticket) {
        const value = signedPayload(ticket);
        if (value?.contract !== contract || value.action !== action || value.epoch !== epoch ||
            value.backendNamespace !== backend || value.directory !== engine.directory ||
            ![value.connectionId, value.operation, value.ownerId, value.callID].every(label) ||
            !Number.isSafeInteger(value.ownerFence) || value.ownerFence <= 0 ||
            !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() ||
            !id(value.sessionID, 'ses_') || !id(value.inputID, 'msg_') || !id(value.assistantMessageID, 'msg_') ||
            !id(value.shellID, 'sh_') || value.jobID !== value.shellID ||
            !hash(value.commandDigest) || !hash(value.argumentsDigest)) denied();
        if (action === 'release' && (!id(value.notificationID, 'msg_') || !hash(value.notificationDigest))) denied();
        if (action === 'stop' && (value.notificationID != null || value.notificationDigest != null)) denied();
        if (value.acceptanceId == null ? value.operationDigest != null :
            !uuid(value.acceptanceId) || !hash(value.operationDigest)) denied();
        if (value.detachedStop !== undefined && typeof value.detachedStop !== 'boolean' ||
            value.detachedStop && (action !== 'stop' || value.acceptanceId == null)) denied();
        return value;
    }

    async function apply(action, binding) {
        const result = await engine[action](binding);
        return { epoch, operation: binding.operation, shellID: binding.shellID,
            notificationID: binding.notificationID ?? null, acceptanceId: binding.acceptanceId ?? null,
            operationDigest: binding.operationDigest ?? null, result: result ?? null };
    }

    async function deliverAccepted(action, binding) {
        const key = JSON.stringify([binding.connectionId, binding.sessionID, binding.shellID]);
        const pending = (delivering.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
            const session = await ctx.session.get({ sessionID: binding.sessionID });
            const managed = session.metadata?.sam;
            const control = session.metadata?.samBackground;
            if (binding.detachedStop) {
                if (binding.expiresAt <= Date.now() || managed?.epoch !== epoch) denied();
                // The durable Stop authorizes the historical Job. The engine checks the original
                // daemon attribution even when a newer Run has reconfigured this Session.
                return apply(action, binding);
            }
            if (binding.expiresAt <= Date.now() ||
                managed != null && (managed.epoch !== epoch || managed.inputId !== binding.inputID) ||
                control?.contract !== 'sam.opencode-shell-report-control/v1' || control.operation !== binding.operation ||
                control.inputId !== binding.inputID) denied();
            if (action === 'release' && managed?.backgroundJobs === contract) {
                if (managed.operation !== binding.operation) denied();
                const key = releaseKey(binding.sessionID, binding.inputID, binding.notificationID);
                const prior = await ctx.storage.get(key);
                const { expiresAt, ...accepted } = binding;
                if (prior && (prior.acceptanceId !== accepted.acceptanceId ||
                    prior.operationDigest !== accepted.operationDigest)) denied();
                if (!prior) await ctx.storage.set(key, accepted);
            }
            return apply(action, binding);
        });
        delivering.set(key, pending);
        try { return await pending; }
        finally { if (delivering.get(key) === pending) delivering.delete(key); }
    }

    async function mutate(action, ticket) {
        const binding = grant(action, ticket);
        if (binding.acceptanceId != null) return deliverAccepted(action, binding);
        const operationKey = JSON.stringify([binding.connectionId, binding.sessionID, binding.operation]);
        const previous = owners.get(operationKey);
        if (previous && (binding.ownerFence < previous.fence ||
            binding.ownerFence === previous.fence && binding.ownerId !== previous.owner)) denied();

        const pending = (previous?.pending ?? Promise.resolve()).catch(() => {}).then(async () => {
            const session = await ctx.session.get({ sessionID: binding.sessionID });
            // Standalone grants do not participate in SAM's durable Runtime ownership.
            if (session.metadata?.sam != null) denied();
            // A newer fence may have arrived while this invocation was queued.
            const current = owners.get(operationKey);
            if (binding.ownerFence !== current.fence || binding.ownerId !== current.owner ||
                binding.expiresAt <= Date.now()) denied();
            return apply(action, binding);
        });
        owners.set(operationKey, { fence: binding.ownerFence, owner: binding.ownerId, pending });
        return pending;
    }

    return {
        qualification,
        async lateInput(sessionId, expected, ticket) {
            const value = signedPayload(ticket);
            if (value?.contract !== 'opencode.background-result.v1' || value.epoch !== epoch ||
                value.backendNamespace !== backend || value.sessionId !== sessionId ||
                sessionId === value.sourceSessionId || !id(value.sourceSessionId, 'ses_') ||
                !uuid(value.sourceExecutionId) || !id(value.sourceInputId, 'msg_') ||
                !id(value.shellId, 'sh_') || !label(value.callId) ||
                !id(value.notificationId, 'msg_') || value.notificationId !== expected.lateBackgroundNotificationId ||
                value.operation !== expected.operation || value.inputId !== expected.inputId ||
                !hash(value.reportSha256) || value.reportSha256 !== expected.inputDigest ||
                !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) denied();
            const reports = wire(await engine.reports(value.sourceSessionId, value.notificationId));
            const record = reports.entries.filter(entry => entry.type === 'synthetic' && entry.delivery === 'queue' &&
                entry.sessionID === value.sourceSessionId && entry.id === value.notificationId);
            const metadata = record[0]?.payload?.metadata;
            const proof = metadata?.opencodeShellReport;
            const text = record[0]?.payload?.text;
            if (record.length !== 1 || reports.delivered != null || metadata?.source !== 'shell' ||
                metadata.shellID !== value.shellId || metadata.jobID !== value.shellId ||
                proof?.held !== true || proof.notificationID !== value.notificationId ||
                proof.sessionID !== value.sourceSessionId || proof.sha256 !== value.reportSha256 ||
                proof.origin?.inputID !== value.sourceInputId || proof.origin?.operation !== value.sourceExecutionId ||
                proof.origin?.callID !== value.callId || !['exited', 'killed', 'timeout'].includes(proof.terminal?.status) ||
                typeof text !== 'string' || digest(text) !== value.reportSha256) denied();
            return text;
        },
        async deleteDetachedSession(sessionId, ticket) {
            const value = signedPayload(ticket);
            if (!qualification || value?.contract !== 'opencode.detached-session-cleanup.v1' ||
                value.epoch !== epoch || value.backendNamespace !== backend || value.sessionId !== sessionId ||
                !id(sessionId, 'ses_') || !id(value.inputId, 'msg_') ||
                !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() ||
                !Array.isArray(value.reports) || value.reports.length === 0 ||
                new Set(value.reports.map(item => item.notificationId)).size !== value.reports.length) denied();
            const matches = session => session.metadata?.sam?.epoch === epoch &&
                session.metadata.sam.inputId === value.inputId && session.location?.directory === engine.directory &&
                session.metadata?.samBackground?.contract === 'sam.opencode-shell-report-control/v1' &&
                (!session.time?.busy || session.time.idle >= session.time.busy);
            if (!matches(await ctx.session.get({ sessionID: sessionId }))) denied();
            const { entries } = wire(await engine.reports(sessionId));
            if (entries.length !== value.reports.length) denied();
            for (const report of value.reports) {
                const entry = entries.find(item => item.id === report.notificationId && item.delivery === 'queue');
                const metadata = entry?.payload?.metadata;
                const proof = metadata?.opencodeShellReport;
                const current = wire(await engine.read(report.shellId));
                if (!entry || proof?.held !== true || proof.sessionID !== sessionId ||
                    proof.notificationID !== report.notificationId || metadata.shellID !== report.shellId ||
                    proof.sha256 !== report.notificationDigest || digest(entry.payload.text) !== report.notificationDigest ||
                    proof.origin?.operation !== report.operation || proof.origin?.inputID !== report.inputId ||
                    proof.origin?.callID !== report.callId || current.conflict !== false ||
                    !['exited', 'killed', 'timeout'].includes(current.shell?.status) ||
                    current.shell.status !== proof.terminal?.status || current.shell.time?.completed !== proof.terminal?.completed ||
                    current.origin?.operation !== report.operation || current.origin?.inputID !== report.inputId ||
                    current.origin?.callID !== report.callId) denied();
            }
            if (!matches(await ctx.session.get({ sessionID: sessionId }))) denied();
            await ctx.session.remove({ sessionID: sessionId });
            return { epoch, sessionId };
        },
        async continuation(sessionId, expected, message, tools) {
            if (!qualification || expected.backgroundJobs !== contract || expected.epoch !== epoch ||
                message?.type !== 'synthetic' || !id(message.id, 'msg_') || typeof message.text !== 'string') return false;
            const binding = await ctx.storage.get(releaseKey(sessionId, expected.inputId, message.id));
            if (!binding || binding.sessionID !== sessionId || binding.inputID !== expected.inputId ||
                binding.operation !== expected.operation || binding.epoch !== epoch ||
                binding.notificationID !== message.id || binding.notificationDigest !== digest(message.text)) return false;
            const tool = tools.get(binding.callID);
            if (tool?.background !== true || tool.message !== binding.assistantMessageID ||
                tool.shellId !== binding.shellID || tool.shellCommandDigest !== binding.commandDigest) return false;
            const { delivered } = wire(await engine.reports(sessionId, message.id));
            const proof = delivered?.metadata?.opencodeShellReport;
            const origin = proof?.origin;
            return delivered?.type === 'synthetic' && delivered.id === message.id && delivered.text === message.text &&
                delivered.metadata.shellID === binding.shellID && delivered.metadata.jobID === binding.jobID &&
                proof?.held === true && proof.sessionID === sessionId && proof.notificationID === message.id &&
                proof.sha256 === binding.notificationDigest && proof.commandDigest === binding.commandDigest &&
                ['exited', 'killed', 'timeout'].includes(proof.terminal?.status) &&
                Number.isSafeInteger(proof.terminal.completed) &&
                (Number.isInteger(proof.terminal.exit) || typeof proof.terminal.signal === 'string') &&
                origin?.sessionID === sessionId && origin.inputID === expected.inputId && origin.operation === expected.operation &&
                origin.assistantMessageID === binding.assistantMessageID && origin.callID === binding.callID &&
                origin.argumentsDigest === binding.argumentsDigest;
        },
        methods: {
            async 'background-read'({ shellId }) {
                if (!qualification || !id(shellId, 'sh_')) unavailable();
                return wire({ epoch, shellID: shellId, ...await engine.read(shellId) });
            },
            async 'background-output'({ shellId, cursor, limit }) {
                if (!qualification || !id(shellId, 'sh_') || !Number.isSafeInteger(cursor) || cursor < 0 ||
                    !Number.isSafeInteger(limit) || limit <= 0 || limit > 65536) unavailable();
                return { epoch, shellID: shellId, ...await engine.output(shellId, { cursor, limit }) };
            },
            async 'background-reports'({ sessionId, notificationId }) {
                if (!qualification || !id(sessionId, 'ses_') ||
                    notificationId != null && !id(notificationId, 'msg_')) unavailable();
                return wire({ epoch, sessionID: sessionId, ...await engine.reports(sessionId, notificationId ?? undefined) });
            },
            'background-release': input => mutate('release', input),
            'background-stop': input => mutate('stop', input)
        }
    };
}
