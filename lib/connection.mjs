import { randomUUID, createHash } from 'node:crypto';

export function sessionStart(session) {
  return { type: 'session.start', event_id: randomUUID(), session };
}

export function openLiveSocket({ WebSocket, endpoint, apiKey, session, isCurrent, onSend }) {
  const ws = new WebSocket(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 15000,
    maxPayload: 8 * 1024 * 1024,
  });
  ws.on('open', () => {
    if (!isCurrent(ws)) return;
    const event = sessionStart(session);
    ws.send(JSON.stringify(event));
    onSend(event);
  });
  return ws;
}

// Read the loaded functions, rather than a separate illustrative snippet.
const code = `import { randomUUID } from 'node:crypto';\n\n${sessionStart.toString()}\n\n${openLiveSocket.toString()}`;
export const connectionSource = Object.freeze({ file: 'lib/connection.mjs', code, sha256: createHash('sha256').update(code).digest('hex') });
