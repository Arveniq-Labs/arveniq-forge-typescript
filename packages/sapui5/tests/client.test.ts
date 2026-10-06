import assert from 'node:assert/strict';
import test from 'node:test';
import { ForgeChatGatewayClient, ChatGatewayError } from '../src/client.js';
import type { ForgeChatEvent } from '../src/types.js';

export function event(type: ForgeChatEvent['type'], data: ForgeChatEvent['data'] = {}, sequence = '1'): ForgeChatEvent {
  return { version: 1, conversationId: 'c1', turnId: 't1', messageId: 'm1', createdAt: '', type, data, sequence, eventId: `e${sequence}` };
}
export function sse(events: ForgeChatEvent[]) {
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}
function client(fetcher: typeof fetch, options = {}) {
  return new ForgeChatGatewayClient({ baseUrl: '/api/forge-chat', origin: 'https://sap.example', fetcher, reconnectDelayMs: 0, ...options });
}
test('same-origin gateway rejects Developer endpoints, foreign origins and embedded credentials', () => {
  for (const baseUrl of ['https://forge.example/v1', 'https://user:secret@sap.example/api', '/v1/developer/v1', '/api?key=secret', '/api#token']) {
    assert.throws(() => new ForgeChatGatewayClient({ baseUrl, origin: 'https://sap.example' }));
  }
});
test('accepted stream reconnects by turn and cursor, deduplicates replay, and uses host CSRF/session only', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = client(async (url, init) => {
    requests.push({ url: String(url), init });
    return requests.length === 1 ? sse([event('turn.accepted', {}, '0'), event('response.delta', { delta: 'Hi 🌏' }, '1')])
      : sse([event('response.delta', { delta: 'Hi 🌏' }, '1'), event('turn.completed', { status: 'completed' }, '2')]);
  }, { csrfTokenProvider: async () => 'host-csrf' });
  const events = await Array.fromAsync(gateway.streamMessage('c1', { clientMessageId: 'stable', message: 'Hello' }));
  assert.equal(events.length, 3);
  assert.equal(requests[1]?.url, 'https://sap.example/api/forge-chat/conversations/c1/turns/t1/events');
  assert.equal(new Headers(requests[1]?.init?.headers).get('Last-Event-ID'), 'e1');
  assert.equal(new Headers(requests[0]?.init?.headers).get('X-CSRF-Token'), 'host-csrf');
  assert.equal(new Headers(requests[0]?.init?.headers).get('Authorization'), null);
  assert.equal(requests[0]?.init?.credentials, 'same-origin');
});
test('lost initial response retries exactly the same message identifier and body', async () => {
  const bodies: unknown[] = [];
  const gateway = client(async (_url, init) => { bodies.push(init?.body); if (bodies.length === 1) throw new TypeError('network'); return sse([event('turn.completed')]); });
  await Array.fromAsync(gateway.streamMessage('c1', { clientMessageId: 'stable', message: 'hello' }));
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
});
test('permission errors and mismatched stream identities fail without replaying a send', async () => {
  let calls = 0;
  const denied = client(async () => { calls++; return new Response('', { status: 403 }); });
  await assert.rejects(() => Array.fromAsync(denied.streamMessage('c1', { clientMessageId: 'm1', message: 'hi' })), ChatGatewayError);
  assert.equal(calls, 1);
  const wrong = client(async () => sse([{ ...event('turn.completed'), conversationId: 'other' }]));
  await assert.rejects(() => Array.fromAsync(wrong.resumeTurn('c1', 't1')), /Unexpected conversation/);
});
test('approval is a settled stream and resumption validates sequences', async () => {
  const gateway = client(async () => sse([event('turn.requires_action', { status: 'approval_required' })]));
  assert.equal((await Array.fromAsync(gateway.resumeTurn('c1', 't1'))).length, 1);
  await assert.rejects(() => Array.fromAsync(gateway.resumeTurn('c1', 't1', { afterSequence: 'bad' })), /Invalid event sequence/);
});
test('abort stops retries and cancellation has its own authenticated mutation', async () => {
  const controller = new AbortController(); let calls = 0;
  const gateway = client(async (_url, init) => { calls++; controller.abort(); throw new TypeError('network'); });
  await assert.rejects(() => Array.fromAsync(gateway.resumeTurn('c1', 't1', { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls, 1);
  const cancel = client(async (url, init) => { assert.match(String(url), /turns\/t1\/cancel$/); assert.equal(init?.method, 'POST'); return new Response(null, { status: 204 }); });
  await cancel.cancelTurn('c1', 't1');
});
