import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatHistorySearch } from '../src/search.js';
import type { ChatGateway, ConversationSummary } from '../src/types.js';
const conversations: ConversationSummary[] = [
  { id: 'c1', title: 'Quarterly planning', createdAt: '2026-10-01' },
  { id: 'c2', title: 'Inventory', createdAt: '2026-10-02' },
  { id: 'c3', title: 'Café sales', createdAt: '2026-10-03' },
];
function gateway(overrides: Partial<ChatGateway> = {}): ChatGateway {
  return { listConversations: async () => conversations, createConversation: async () => conversations[0]!,
    getConversation: async id => ({ id, agentId: 'a1', createdAt: '', turns: [{ id: 't1', clientMessageId: 'm1', status: 'completed',
      message: id === 'c1' ? 'Review forecast' : 'Question', text: id === 'c1' ? 'Revenue forecast for October is 500.' : 'No special message.', createdAt: '' }] }),
    async *streamMessage() {}, async *resumeTurn() {}, cancelTurn: async () => {}, ...overrides };
}
test('full-text search finds answer-only matches, returns a useful snippet/index, and reuses loaded histories', async () => {
  let reads = 0; const base = gateway();
  const search = new ChatHistorySearch(gateway({ getConversation: async (id, signal) => { reads++; return base.getConversation(id, signal); } }));
  const first = await search.search('OCTOBER revenue', conversations);
  assert.deepEqual(first.results.map(result => result.id), ['c1']); assert.equal(first.results[0]?.matchedIn, 'message');
  assert.equal(first.results[0]?.messageIndex, 1); assert.match(first.results[0]!.snippet, /October/);
  await search.search('forecast', conversations); assert.equal(reads, 3);
});
test('title matches are ranked first and support quoted phrases, multiple terms and accents', async () => {
  const search = new ChatHistorySearch(gateway());
  assert.equal((await search.search('cafe "sales"', conversations)).results[0]?.id, 'c3');
  assert.deepEqual((await search.search('"revenue forecast" October', conversations)).results.map(result => result.id), ['c1']);
  assert.deepEqual(search.peek('', conversations).map(result => result.id), ['c3', 'c2', 'c1']);
});
test('history reads are bounded to three concurrent requests and failures remain visible/retryable', async () => {
  const chats = Array.from({ length: 9 }, (_, i) => ({ id: 'c' + i, title: 'Chat', createdAt: '' }));
  let active = 0; let maximum = 0; let reads = 0; const base = gateway();
  const search = new ChatHistorySearch(gateway({ getConversation: async id => {
    reads++; active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (id === 'c0') throw new Error('forbidden'); return base.getConversation(id);
  } }));
  const result = await search.search('October', chats); assert.equal(result.failed, 1); assert.equal(result.searched, 9); assert.equal(maximum, 3);
  await search.search('October', chats); assert.equal(reads, 10);
});
test('cancellation discards an old query even if a custom gateway ignores AbortSignal', async () => {
  let release!: () => void;
  const base = gateway(); const search = new ChatHistorySearch(gateway({ getConversation: async id => {
    await new Promise<void>(resolve => { release = resolve; }); return base.getConversation(id);
  } }));
  const abort = new AbortController(); let updates = 0;
  const result = search.search('October', [conversations[0]!], abort.signal, () => updates++);
  abort.abort(); release(); await assert.rejects(result, { name: 'AbortError' }); assert.equal(updates, 1);
});
test('native host search is preferred and receives the cancellation signal', async () => {
  let delegated = false; const abort = new AbortController();
  const search = new ChatHistorySearch(gateway({ getConversation: async () => { throw new Error('must not fetch'); },
    searchConversations: async (query, signal) => {
      delegated = true; assert.equal(query, 'needle'); assert.equal(signal, abort.signal);
      return [{ ...conversations[0]!, snippet: 'needle', matchedIn: 'message', messageIndex: 1 }];
    } }));
  assert.equal((await search.search('needle', conversations, abort.signal)).results.length, 1); assert.ok(delegated);
});
test('live updates replace cached answer content and removed conversations are not returned', async () => {
  const search = new ChatHistorySearch(gateway()); await search.search('October', conversations);
  search.remember('c1', [{ id: 'm1', role: 'assistant', text: 'Revised November forecast.' }]);
  assert.equal(search.peek('November', conversations)[0]?.id, 'c1'); assert.equal(search.peek('October', conversations).length, 0);
  assert.equal((await search.search('November', conversations.slice(1))).results.length, 0);
});
