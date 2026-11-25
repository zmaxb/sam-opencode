import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import plugin from '../../tools/opencode/context/index.mjs';

const installer = fileURLToPath(new URL('../../tools/opencode/install.sh', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));

let handlers;
let authority;
const releasedReports = [];
let permissions;
const sessionHooks = new Map();
const toolHooks = new Map();
let transform;
let wrappedPatch;
let wrappedShell;
let shellExecutions = 0;
const hook = () => {};
await plugin.setup({
    permission: { hook },
    session: {
        hook: (name, callback) => sessionHooks.set(name, callback),
        get: async () => ({ metadata: { sam: authority }, permissions }),
        instructions: { entry: { list: async () => [{ key: 'sam-context', value: 'Report context' }] } },
        releaseSubagentReport: async input => { releasedReports.push(input); }
    },
    tool: { hook: (name, callback) => toolHooks.set(name, callback), reload: async () => {}, transform: callback => { transform = callback; } },
    rpc: { register: (_methods, next) => { handlers = next; } }
});

const limited = { output: await handlers.inspect({}) };
const native = new Set(['write', 'edit', 'read', 'glob', 'grep', 'shell']);
const patchDefinition = { description: 'Native patch',
    input: { type: 'object', properties: { patchText: { type: 'string' } }, required: ['patchText'] },
    options: { permission: 'edit' }, execute() {} };
function registerTools(patch) {
    transform({
        update(name, configure) {
            if (native.has(name)) {
                const definition = { description: '', options: { permission: 'edit' }, execute() {
                    if (name === 'shell') shellExecutions++;
                } };
                configure(definition);
                if (name === 'shell') wrappedShell = definition.execute;
            }
            if (name === 'patch' && patch) {
                const definition = { ...patchDefinition, options: { permission: patch } };
                configure(definition);
                wrappedPatch = definition.execute;
            }
        }
    });
}
registerTools('write');
const full = { output: await handlers.inspect({}) };
assert.equal(full.output.nativeToolsWithPatch, null);
registerTools('edit');
const withPatch = { output: await handlers.inspect({}) };
assert.equal(withPatch.output.nativeTools, full.output.nativeTools);
assert.equal(withPatch.output.nativeToolsWithPatch, 'sam.opencode-native-tools/v2');
assert.equal(withPatch.output.patchFullAccessOnly, true);
const unrestrictedPatch = { output: { ...withPatch.output } };
delete unrestrictedPatch.output.patchFullAccessOnly;
const incompatible = { output: { ...full.output, contract: 'unsupported' } };
const legacy = { output: { ...full.output } };
delete legacy.output.attachments;

const digest = value => createHash('sha256').update(value).digest('hex');
const file = (name, text) => ({ name, uri: 'data:text/plain;base64,' + Buffer.from(text).toString('base64') });
const { epoch, digest: catalogDigest } = await handlers.configure({ catalogue: '[]' });
assert.equal(full.output.backgroundJobs, null);
authority = { epoch, catalogDigest, inputId: 'msg_legacy', autonomy: {
    version: 1, selection: 'full_access', permissionEffect: 'allow'
} };
permissions = [
    { action: '*', resource: '*', effect: 'deny' },
    ...['sam_read_confirmation', 'edit', 'external_directory'].map(action => ({ action, resource: '*', effect: 'allow' }))
];
await assert.rejects(wrappedShell({ command: 'fixture', background: true }, { sessionID: 'ses_legacy' }),
    /outside the frozen execution policy/);
assert.equal(shellExecutions, 0);
const files = [file('first.txt', 'alpha'), file('second.txt', 'omega')];
authority = { epoch, catalogDigest, inputId: 'msg_test', inputDigest: digest('Read the files'), continuity: {},
    attachmentManifest: JSON.stringify(files.map((part, index) => ({
        name: part.name, mime: 'text/plain', mode: 'text', wireDigest: digest(['alpha', 'omega'][index])
    }))) };
const admit = items => sessionHooks.get('prompt')({
    sessionID: randomUUID(), messageID: authority.inputId, metadata: { samInput: authority.inputId },
    prompt: { text: 'Read the files', files: items }, delivery: 'queue'
});
await admit(files);
await assert.rejects(admit([file('first.txt', 'ALPHA'), files[1]]), /attachment admission changed/);
await assert.rejects(admit([...files].reverse()), /attachment admission changed/);
await assert.rejects(admit([files[0]]), /attachment count changed/);
await assert.rejects(admit([{ ...files[0], uri: 'file:///tmp/private' }, files[1]]), /attachment type changed/);
await assert.rejects(admit([{ ...files[0], description: 'Override content' }, files[1]]), /attachment admission changed/);
delete authority.attachmentManifest;
await admit([]);
await assert.rejects(admit(files), /attachment count changed/);


const reportSession = 'ses_report_parent';
const original = { epoch, catalogDigest, inputId: 'msg_original', inputDigest: digest('Original input'), continuity: {} };
const reportText = 'Exact native report';
const report = {
    ...original, inputId: 'msg_exact_report', inputDigest: digest(reportText), contextDigest: digest('Report context'),
    continuity: { previousInput: original.inputId }, subagentReportRelease: 'sam.opencode-subagent-report-release/v1',
    reportChildId: 'ses_report_child', reportCallId: 'call_original', operation: randomUUID()
};
authority = original;
await sessionHooks.get('prompt')({
    sessionID: reportSession, messageID: original.inputId, metadata: { samInput: original.inputId },
    prompt: { text: 'Original input' }, delivery: 'queue'
});
const releaseReport = value => handlers['release-report']({ sessionId: reportSession, authority: value });
await assert.rejects(releaseReport(report), /not admitted/);
await handlers.continue({ sessionId: reportSession, previous: original, authority: report, history: { users: [], answers: [], tools: [] } });
await assert.rejects(releaseReport(report), /authority changed/);
authority = report;
await assert.rejects(sessionHooks.get('prompt')({
    sessionID: reportSession, messageID: report.inputId, metadata: { samInput: report.inputId },
    prompt: { text: reportText }, delivery: 'queue'
}), /requires native release/);
await assert.rejects(releaseReport({ ...report, inputId: 'msg_other' }), /not admitted/);
assert.deepEqual(releasedReports, []);
assert.deepEqual(await releaseReport(report), { epoch, notificationId: report.inputId });
await assert.rejects(releaseReport(report), /not admitted/);
assert.deepEqual(releasedReports, [{ sessionID: reportSession, inboxID: report.inputId }]);
const reportContext = (id, text) => sessionHooks.get('context')({
    sessionID: reportSession, system: [], messages: [{ role: 'user', id, content: text }], tools: {}
});
await reportContext(report.inputId, reportText);
await assert.rejects(reportContext('msg_other', reportText), /input not available/);
await assert.rejects(reportContext(report.inputId, 'Altered report'), /input not available/);

const nativeActions = ['edit', 'external_directory', 'read', 'glob', 'grep', 'shell'];
async function patchCatalogue(nativeTools, ordered, visible, nativePatch = true, ask = false) {
    const sessionID = randomUUID();
    const autonomy = ordered ? { version: 2, selection: 'approve_for_me', permissionEffect: 'rules', rules: JSON.stringify(ordered) }
        : { version: 1, selection: ask ? 'ask_for_approval' : 'full_access', permissionEffect: ask ? 'ask' : 'allow' };
    const effect = ordered ? 'ask' : autonomy.permissionEffect;
    const rule = (action, effect) => ({ action, resource: '*', effect });
    permissions = [rule('*', 'deny'), rule('sam_read_confirmation', effect),
        ...nativeActions.map(action => rule(action, effect)), ...(ordered ?? [])];
    authority = { epoch, catalogDigest, inputId: 'msg_native', model: 'local-model',
        inputDigest: digest('Apply the patch'), contextDigest: digest('Frozen context'), nativeTools, autonomy };
    const tools = { ...Object.fromEntries([...native].map(name => [name, {}])), subagent: {} };
    if (nativePatch) tools.patch = patchDefinition;
    await sessionHooks.get('context')({ sessionID, tools });
    assert.deepEqual(Object.keys(tools).sort(), [...native].filter(name =>
        !ordered?.some(rule => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'deny') || !['edit', 'write'].includes(name))
        .concat(visible ? ['patch'] : []).sort());
    const execute = () => toolHooks.get('execute.before')({ sessionID, tool: 'patch' });
    if (visible) {
        if (nativePatch) assert.strictEqual(tools.patch, patchDefinition);
        else {
            assert.equal(tools.patch.description, patchDefinition.description);
            assert.equal(tools.patch.input.properties.patchText.type, 'string');
            assert.deepEqual(tools.patch.input.required, ['patchText']);
            assert.equal(tools.patch.input.additionalProperties, false);
        }
        await execute();
    } else {
        await assert.rejects(execute(), /outside the frozen catalogue/);
        await assert.rejects(wrappedPatch({ patchText: 'do not execute' }, { sessionID }),
            /native tool is outside the frozen execution policy/);
    }
    return { sessionID, tools, authority, permissions };
}
await patchCatalogue(full.output.nativeTools, null, false);
await patchCatalogue(withPatch.output.nativeToolsWithPatch, null, true);
await patchCatalogue(withPatch.output.nativeToolsWithPatch, null, true, false);
await patchCatalogue(withPatch.output.nativeToolsWithPatch, [{ action: 'edit', resource: '*', effect: 'deny' }], false);
const askCatalogue = await patchCatalogue(withPatch.output.nativeToolsWithPatch, null, false, true, true);
const rulesCatalogue = await patchCatalogue(withPatch.output.nativeToolsWithPatch, [{ action: 'edit', resource: '*', effect: 'allow' }], false);
await patchCatalogue(withPatch.output.nativeToolsWithPatch, [{ action: 'edit', resource: 'private.txt', effect: 'deny' }], false);


async function rejectWireCatalogue(run, offeredTools) {
    ({ authority, permissions } = run);
    const request = new Request('http://127.0.0.1:11434/v1/chat/completions', { method: 'POST', body: JSON.stringify({
        model: authority.model,
        messages: [{ role: 'system', content: '<context key="sam-context">\nFrozen context\n</context>' },
            { role: 'user', content: 'Apply the patch' }],
        tools: Object.entries(offeredTools).map(([name, tool]) => ({ type: 'function', function: {
            name, description: tool.description, parameters: tool.input
        } }))
    }) });
    await assert.rejects(sessionHooks.get('http.request')({
        sessionID: run.sessionID, kind: 'primary', model: { id: authority.model, providerID: 'ollama' }, request
    }), /tool catalogue did not survive serialization/);
}
for (const restricted of [askCatalogue, rulesCatalogue])
    await rejectWireCatalogue(restricted, { ...restricted.tools, patch: patchDefinition });
const fullCatalogue = await patchCatalogue(withPatch.output.nativeToolsWithPatch, null, true, false);
await rejectWireCatalogue(fullCatalogue, { ...fullCatalogue.tools,
    patch: { ...fullCatalogue.tools.patch, input: { ...fullCatalogue.tools.patch.input, required: [] } } });

let reply;
const server = createServer((request, response) => {
    assert.equal(request.method, 'POST');
    const url = new URL(request.url, 'http://127.0.0.1');
    assert.equal(url.pathname, '/api/rpc/sam-opencode-context/inspect');
    assert.equal(url.searchParams.get('location[directory]'), root);
    request.resume();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(reply));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');

async function verifyInstaller(value, expected, diagnostic) {
    reply = value;
    const process = spawn('bash', [installer, '--inspect', 'http://127.0.0.1:' + server.address().port,
        '--directory', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [process.stdout, process.stderr]) {
        stream.setEncoding('utf8');
        stream.on('data', data => { output += data; });
    }
    const [status] = await once(process, 'close');
    assert.equal(status, expected, output);
    assert.match(output, diagnostic);
    return output;
}

try {
    await verifyInstaller(full, 0, /confirmed \(epoch/);
    await verifyInstaller(withPatch, 0, /sam\.opencode-native-tools\/v2 confirmed/);
    assert.doesNotMatch(await verifyInstaller(unrestrictedPatch, 0, /sam\.opencode-native-tools\/v1 confirmed/),
        /sam\.opencode-native-tools\/v2 confirmed/);
    await verifyInstaller(limited, 1, /did not confirm sam\.opencode-autonomy/);
    await verifyInstaller(legacy, 1, /did not confirm sam\.opencode-attachments/);
    await verifyInstaller(incompatible, 1, /did not confirm sam\.opencode-wire/);
    console.log(JSON.stringify({ full, withPatch, unrestrictedPatch, limited, legacy, incompatible }));
} finally {
    server.close();
}
