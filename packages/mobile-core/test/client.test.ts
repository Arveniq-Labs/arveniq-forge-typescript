import assert from 'node:assert/strict';
import test from 'node:test';
import { ForgeMobileClient, MobileProtocolError, createContextAssertion } from '../src/index.js';

const assertion = createContextAssertion('signed-and-expiring-context-assertion-value-001');

test('uses a gateway bearer token without exposing a developer key', async () => {
  let authorization = '';
  let developerKey = '';
  const client = new ForgeMobileClient({
    baseUrl: 'https://gateway.capitalfi.example/v1',
    credentialProvider: { getAccessToken: async () => 'short-lived-gateway-token' },
    fetcher: async (_input, init) => {
      const headers = new Headers(init?.headers);
      authorization = headers.get('authorization') ?? '';
      developerKey = headers.get('x-forge-developer-key') ?? '';
      return Response.json({ id: 'conversation-1', createdAt: '2026-09-22T10:00:00Z' }, { status: 201 });
    },
  });
  await client.createConversation({ contextAssertion: assertion, agentHandle: 'financial-assistant' });
  assert.equal(authorization, 'Bearer short-lived-gateway-token');
  assert.equal(developerKey, '');
});

test('rejects non-local insecure gateway URLs', () => {
  assert.throws(
    () => new ForgeMobileClient({ baseUrl: 'http://gateway.example/v1', credentialProvider: { getAccessToken: async () => 'token' } }),
    MobileProtocolError,
  );
});

test('parses gateway SSE events', async () => {
  const event = JSON.stringify({ id: 'evt-1', type: 'response.delta', conversationId: 'conversation-1', turnId: 'turn-1', sequence: '3', data: { delta: 'Hello' } });
  const client = new ForgeMobileClient({
    baseUrl: 'https://gateway.example/v1',
    credentialProvider: { getAccessToken: async () => 'token' },
    fetcher: async () => new Response(`event: response.delta\ndata: ${event}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
  });
  const events = [];
  for await (const item of client.streamMessage('conversation-1', { clientMessageId: 'message-1', message: 'Hi', contextAssertion: assertion })) events.push(item);
  assert.deepEqual(events, [{ id: 'evt-1', type: 'response.delta', conversationId: 'conversation-1', turnId: 'turn-1', sequence: '3', data: { delta: 'Hello' } }]);
});
