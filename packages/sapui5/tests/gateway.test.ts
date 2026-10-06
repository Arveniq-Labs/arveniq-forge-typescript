import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createChatGateway, type ChatPrincipal, type OwnedConversation, type ChatGatewayOptions } from '../server/index.js';

test('gateway checks authentication, tenant/user ownership and CSRF before every Forge operation', async t => {
  let calls = 0;
  const records = new Map<string, OwnedConversation>([['c1', { id: 'c1', title: 'Chat', createdAt: '', userId: 'alice', tenantId: 'one' }]]);
  const forge: ChatGatewayOptions['forge'] = {
    async createConversation({ agentId }) { calls++; assert.equal(agentId, 'configured-agent'); return { id: 'c2', agentId, createdAt: '' }; },
    async getConversation(id) { calls++; return { id, agentId: 'a1', createdAt: '', turns: [] }; },
    async *streamMessage(id, input) {
      calls++; yield { version: 1, type: 'turn.completed', conversationId: id, turnId: 't1', messageId: input.clientMessageId,
        createdAt: '', data: { status: 'completed' } };
    },
    async *streamConversationTurn(id, turnId) { calls++; yield { version: 1, type: 'turn.completed', conversationId: id, turnId, messageId: 'm1', createdAt: '', data: {} }; },
    async cancelConversationTurn(conversationId, turnId) { calls++; return { conversationId, turnId }; },
  };
  const handler = createChatGateway({ forge, agentId: 'configured-agent',
    // Fixture identity only; production hosts must validate SAP sessions/JWTs.
    authenticate: async request => request.headers['x-test-user'] ? {
      userId: String(request.headers['x-test-user']), tenantId: String(request.headers['x-test-tenant']),
    } : null,
    verifyMutation: async request => request.headers['x-csrf-token'] === 'fixture-token',
    conversations: { get: async id => records.get(id), list: async () => [...records.values()], put: async record => { records.set(record.id, record); } },
  });
  const server = createServer(async (request, response) => { if (!(await handler(request, response))) { response.writeHead(404); response.end(); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/forge-chat`;
  const send = (path: string, init: RequestInit = {}, principal: ChatPrincipal | null = { userId: 'alice', tenantId: 'one' }) => fetch(base + path, {
    ...init, headers: { ...(principal ? { 'x-test-user': principal.userId, 'x-test-tenant': principal.tenantId } : {}), ...init.headers },
  });
  assert.equal((await send('/conversations/c1', {}, null)).status, 401);
  assert.equal((await send('/conversations/c1', {}, { userId: 'bob', tenantId: 'one' })).status, 404);
  assert.equal((await send('/conversations/c1', {}, { userId: 'alice', tenantId: 'two' })).status, 404);
  assert.deepEqual((await (await send('/conversations', {}, { userId: 'bob', tenantId: 'one' })).json()), { items: [] });
  for (const path of ['/conversations', '/conversations/c1/messages', '/conversations/c1/turns/t1/cancel']) {
    assert.equal((await send(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  }
  assert.equal(calls, 0);
  const mutation = { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-token' } };
  assert.equal((await send('/conversations', { ...mutation, body: '{"padding":"' + 'x'.repeat(70_000) + '"}' })).status, 413);
  assert.equal((await send('/conversations', { ...mutation, body: 'not-json' })).status, 400);
  assert.equal((await send('/conversations', { ...mutation, body: '[]' })).status, 400);
  assert.equal((await send('/conversations', { ...mutation, body: JSON.stringify({ agentId: 'browser-agent' }) })).status, 400);
  assert.equal((await send('/conversations', { ...mutation, body: '{}' })).status, 201);
  assert.equal(records.get('c2')?.userId, 'alice');
  assert.equal((await send('/conversations/c1/messages', { ...mutation, body: JSON.stringify({ clientMessageId: 'm1', message: 'hi', attachmentIds: ['unsupported'] }) })).status, 501);
  const streamed = await send('/conversations/c1/messages', { ...mutation, body: JSON.stringify({ clientMessageId: 'stable', message: 'hello' }) });
  assert.match(streamed.headers.get('content-type')!, /event-stream/); assert.match(await streamed.text(), /turn.completed/);
  assert.equal((await send('/conversations/c1/turns/t1/cancel', { ...mutation, body: '{}' })).status, 204);
  assert.equal((await send('/conversations/c1/turns/t1/events')).status, 200);
  assert.equal(calls, 4);
});
