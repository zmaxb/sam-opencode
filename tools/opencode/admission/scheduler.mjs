// One scheduler is owned by the single ingress serving this physical resource.
export function admission({ agentBurst = 3, maxWaiting = 32 } = {}) {
    const waiting = { agent: [], processor: [] };
    let active = false;
    let servedAgents = 0;

    function pump() {
        if (active) return;
        const processorWaiting = waiting.processor.length !== 0;
        const role = waiting.agent.length && (!processorWaiting || servedAgents < agentBurst) ? 'agent' : 'processor';
        const entry = waiting[role].shift();
        if (!entry) return;
        entry.cleanup();
        active = true;
        servedAgents = role === 'agent' && processorWaiting ? servedAgents + 1 : 0;
        let released = false;
        entry.resolve(() => {
            if (released) return;
            released = true;
            active = false;
            pump();
        });
    }

    return {
        acquire(role, signal) {
            if (role !== 'agent' && role !== 'processor') throw new Error('invalid_inference_role');
            if (signal.aborted) return Promise.reject(signal.reason);
            if (waiting.agent.length + waiting.processor.length >= maxWaiting)
                return Promise.reject(new Error('inference_queue_full'));

            return new Promise((resolve, reject) => {
                const queue = waiting[role];
                const withdraw = () => {
                    queue.splice(queue.indexOf(entry), 1);
                    entry.cleanup();
                    if (!waiting.processor.length) servedAgents = 0;
                    reject(signal.reason);
                };
                const entry = { resolve, cleanup: () => signal.removeEventListener('abort', withdraw) };
                queue.push(entry);
                signal.addEventListener('abort', withdraw, { once: true });
                pump();
            });
        },
        read() {
            return { active, waitingAgent: waiting.agent.length, waitingProcessor: waiting.processor.length };
        }
    };
}
