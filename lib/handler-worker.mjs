import { parentPort, workerData } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
const pending = new Map(); let sequence = 0;
function request(kind, data) {
  const requestId = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    parentPort.postMessage({ kind, requestId, ...data });
  });
}
parentPort.on('message', ({ requestId, error, value }) => {
  const p = pending.get(requestId); if (!p) return;
  pending.delete(requestId); error ? p.reject(new Error(error)) : p.resolve(value);
});
const log = (...args) => parentPort.postMessage({ kind: 'log', args });
console.log = console.info = console.warn = console.error = log;
try {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(workerData.code).toString('base64')}`);
  if (typeof mod.onDelegation !== 'function') throw new Error('export async function onDelegation(event, ctx) が必要です');
  parentPort.postMessage({ kind: 'ready' });
  if (!workerData.validateOnly) {
    await mod.onDelegation(workerData.event, {
      send: event => request('send', { event }), log,
      checkpoint: name => request('checkpoint', { name: String(name) }),
      sleep, transcript: workerData.transcript, parameters: workerData.parameters,
    });
    parentPort.postMessage({ kind: 'completed' });
  }
} catch (error) { parentPort.postMessage({ kind: 'failed', error: error.message }); }
