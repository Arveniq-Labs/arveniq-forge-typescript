import assert from 'node:assert/strict';
import test from 'node:test';
import { ForgeChatSession } from '../src/session.js';
import { formatAnswer } from '../src/format.js';
import type { ChatGateway, ForgeChatEvent } from '../src/types.js';

function event(type: ForgeChatEvent['type'], data: ForgeChatEvent['data'] = {}, sequence = '1'): ForgeChatEvent {
  return { version: 1, conversationId: 'c1', turnId: 't1', messageId: 'm1', createdAt: '', type, data, sequence, eventId: `e${sequence}` };
}
function gateway(overrides: Partial<ChatGateway> = {}): ChatGateway {
  return { listConversations: async () => [], createConversation: async () => ({ id: 'c1', title: 'New chat', createdAt: '' }),
    getConversation: async () => ({ id: 'c1', agentId: 'a1', createdAt: '', turns: [] }),
    async *streamMessage() { yield event('response.completed', { text: 'Hello' }); yield event('turn.completed', { status: 'completed' }, '2'); },
    async *resumeTurn() { yield event('turn.completed', { status: 'completed' }, '2'); }, cancelTurn: async () => {}, ...overrides };
}
test('session creates conversation, streams one assistant message, and publishes immutable snapshots', async () => {
  const session = new ForgeChatSession(gateway()); await session.send('Hello');
  const state = session.getState(); assert.equal(state.messages.length, 2); assert.equal(state.messages[1]?.text, 'Hello');
  assert.equal(state.busy, false); assert.equal(state.canStop, false);
  state.messages[1]!.text = 'changed'; assert.equal(session.getState().messages[1]?.text, 'Hello');
});
test('approval blocks new sends and switching until resume settles the same turn', async () => {
  const session = new ForgeChatSession(gateway({ async *streamMessage() { yield event('turn.requires_action', { status: 'approval_required' }); } }));
  await session.send('hello'); assert.equal(session.getState().approvalRequired, true);
  await assert.rejects(() => session.send('again'), /pending turn/);
  await assert.rejects(() => session.newConversation(), /pending turn/);
  await session.resume(); assert.equal(session.getState().approvalRequired, false); assert.equal(session.getState().canStop, false);
});
test('retry before acceptance preserves clientMessageId and never adds duplicate transcript messages', async () => {
  const ids: string[] = [];
  const session = new ForgeChatSession(gateway({ async *streamMessage(_id, input) {
    ids.push(input.clientMessageId); if (ids.length === 1) throw new Error('lost response'); yield event('turn.completed');
  } }));
  await session.send('hello'); assert.equal(session.getState().canResume, true);
  await session.resume(); assert.equal(ids[0], ids[1]); assert.equal(session.getState().messages.length, 2);
});
test('resume after acceptance keeps assembled text and supplies both replay cursors', async () => {
  const session = new ForgeChatSession(gateway({ async *streamMessage() { yield event('response.delta', { delta: 'first' }); throw new Error('offline'); },
    async *resumeTurn(_id, turnId, options) {
      assert.equal(turnId, 't1'); assert.equal(options?.afterEventId, 'e1'); assert.equal(options?.afterSequence, '1');
      yield event('response.delta', { delta: ' second' }, '2'); yield event('turn.completed', {}, '3');
    } }));
  await session.send('hello'); await session.resume(); assert.equal(session.getState().messages[1]?.text, 'first second');
});
test('history pending turn resumes from zero and replaces historical partial text', async () => {
  const session = new ForgeChatSession(gateway({ getConversation: async () => ({ id: 'c1', agentId: 'a1', createdAt: '',
    turns: [{ id: 't1', clientMessageId: 'm1', status: 'running', message: 'hello', text: 'partial', createdAt: '' }] }),
    async *resumeTurn() { yield event('response.delta', { delta: 'full answer' }); yield event('turn.completed', {}, '2'); } }));
  await session.selectConversation('c1'); await session.resume(); assert.equal(session.getState().messages[1]?.text, 'full answer');
});
test('Stop invokes cancellation, while dispose only disconnects a view', async () => {
  let canceled = 0; let release!: () => void;
  const session = new ForgeChatSession(gateway({ async *streamMessage() {
    yield event('turn.accepted'); await new Promise<void>(resolve => { release = resolve; });
  }, cancelTurn: async () => { canceled++; } }));
  const send = session.send('hello'); await new Promise(resolve => setTimeout(resolve, 10));
  await session.stop(); release(); await send;
  assert.equal(canceled, 1); assert.equal(session.getState().status, 'canceled');
  session.dispose(); assert.equal(canceled, 1);
});
test('file support is optional, and authorized host attachment handles accompany the next message', async () => {
  const disabled = new ForgeChatSession(gateway()); await assert.rejects(() => disabled.attach(new File(['x'], 'x.txt')), /not enabled/);
  const session = new ForgeChatSession(gateway({ uploadAttachment: async () => ({ id: 'a1', name: 'x.txt' }),
    async *streamMessage(_id, input) { assert.deepEqual(input.attachmentIds, ['a1']); yield event('turn.completed'); } }));
  await session.attach(new File(['x'], 'x.txt')); await session.send('read this'); assert.deepEqual(session.getState().attachments, []);
});
test('answer rendering escapes HTML, keeps code opaque, and rejects unsafe links', () => {
  const html = formatAnswer('**Hello**\n<img src=x onerror=alert(1)>\n`**code**`\n[bad](javascript:alert(1))');
  assert.match(html, /<strong>Hello<\/strong>/); assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<a')); assert.match(html, /<code>\*\*code\*\*<\/code>/);
});
