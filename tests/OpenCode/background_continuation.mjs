import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { background, contract } from '../../tools/opencode/context/background.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
process.env.SAM_OPENCODE_BACKGROUND_AUDIENCE = 'managed-fixture';
process.env.SAM_OPENCODE_BACKGROUND_PUBLIC_KEY = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const epoch = randomUUID();
const operation = randomUUID();
const authority = { epoch, operation, inputId: 'msg_original', backgroundJobs: contract };
const session = { metadata: { sam: authority, samBackground: {
    contract: 'sam.opencode-shell-report-control/v1', operation, inputId: authority.inputId
} } };
const message = { type: 'synthetic', id: 'msg_notification', text: 'exact terminal output' };
const binding = {
    contract, action: 'release', epoch, operation, directory: '/fixture', backendNamespace: 'managed-fixture',
    connectionId: randomUUID(), ownerId: randomUUID(), ownerFence: 3, expiresAt: Date.now() + 60_000,
    acceptanceId: randomUUID(), operationDigest: hash('durable-acceptance'),
    sessionID: 'ses_original', inputID: authority.inputId, assistantMessageID: 'msg_assistant', callID: 'call_original',
    shellID: 'sh_original', jobID: 'sh_original', argumentsDigest: hash('arguments'), commandDigest: hash('command'),
    notificationID: message.id, notificationDigest: hash(message.text)
};
const { sessionID, assistantMessageID, callID, inputID, argumentsDigest, commandDigest, shellID } = binding;
const tools = new Map([[callID, { background: true, message: assistantMessageID, shellId: shellID, shellCommandDigest: commandDigest }]]);
let delivered;
let entries = [];
const storage = new Map();
const jobs = background({
    app: { version: '2.3.0' },
    session: { get: async () => session },
    storage: { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) },
    shell: { background: {
        contract: 'sam.opencode-background-engine/v1', directory: '/fixture', read() {}, output() {}, stop() {},
        reports: async () => ({ delivered, entries }),
        release: async () => {}
    } }
}, epoch);
const check = (value = message, frozen = authority, observed = tools) =>
    jobs.continuation(sessionID, frozen, value, observed);
const ticket = value => {
    const bytes = Buffer.from(JSON.stringify(value));
    return { payload: bytes.toString('base64url'),
        signature: sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
};
assert.equal(await check(), false);
await assert.rejects(jobs.methods['background-release'](ticket({ ...binding, acceptanceId: null, operationDigest: null })));
await jobs.methods['background-release'](ticket(binding));
assert.equal(await check(), false);
delivered = { ...message, metadata: {
    shellID, jobID: shellID, opencodeShellReport: { held: true, sessionID, notificationID: message.id,
        sha256: hash(message.text), commandDigest, terminal: { status: 'exited', exit: 0, completed: 1 },
        origin: { sessionID, inputID, operation, assistantMessageID, callID, argumentsDigest } }
} };
assert.equal(await check(), true);
assert.equal(await check({ ...message, text: 'tampered output' }), false);
assert.equal(await check({ ...message, type: 'user' }), false);
assert.equal(await check(message, { ...authority, operation: randomUUID() }), false);
assert.equal(await check(message, authority, new Map()), false);
delivered.metadata.opencodeShellReport.origin.callID = 'different_call';
assert.equal(await check(), false);
await assert.rejects(jobs.methods['background-release'](ticket({ ...binding, acceptanceId: randomUUID() })));

const lateSession = 'ses_late';
const lateAuthority = { operation: randomUUID(), inputId: 'msg_late',
    lateBackgroundNotificationId: message.id, inputDigest: hash(message.text) };
const lateTicket = {
    contract: 'opencode.background-result.v1', epoch, backendNamespace: 'managed-fixture',
    sessionId: lateSession, inputId: lateAuthority.inputId, operation: lateAuthority.operation,
    sourceSessionId: sessionID, sourceExecutionId: operation, sourceInputId: inputID, callId: callID, shellId: shellID,
    notificationId: message.id, reportSha256: hash(message.text), expiresAt: Date.now() + 60_000
};
delivered.metadata.source = 'shell';
delivered.metadata.opencodeShellReport.origin.callID = callID;
const original = { id: message.id, sessionID, type: 'synthetic', delivery: 'queue', payload: delivered };
const lateInput = value => jobs.lateInput(lateSession, lateAuthority, ticket(value));
await assert.rejects(lateInput(lateTicket));
entries = [original];
delivered = undefined;
assert.equal(await lateInput(lateTicket), message.text);
await assert.rejects(lateInput({ ...lateTicket, sourceInputId: 'msg_other' }));
await assert.rejects(lateInput({ ...lateTicket, sessionId: sessionID }));
await assert.rejects(lateInput({ ...lateTicket, reportSha256: hash('different payload') }));
entries.push(original);
await assert.rejects(lateInput(lateTicket));
