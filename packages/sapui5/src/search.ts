import { fold, searchTerms } from './markup';
import type { ChatGateway, ChatMessage, ConversationSearchResult, ConversationSummary } from './types';

interface IndexedChat { messages: Array<{ text: string; role: string }>; storedAt: number }
export interface HistorySearchState { results: ConversationSearchResult[]; searched: number; total: number; failed: number }
/** A panel-scoped, memory-only index. Every uncached history read uses the gateway's ownership checks. */
export class ChatHistorySearch {
  private cache = new Map<string, IndexedChat>();
  constructor(private readonly gateway: ChatGateway) {}
  remember(id: string, messages: ChatMessage[]) {
    this.cache.set(id, { messages: messages.map(message => ({ text: message.text, role: message.role })), storedAt: Date.now() });
  }
  clear() { this.cache.clear(); }
  peek(query: string, conversations: ConversationSummary[]): ConversationSearchResult[] {
    const terms = searchTerms(query);
    if (!terms.length) return [...conversations].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(conversation => ({ ...conversation, snippet: '', matchedIn: 'title' as const }));
    const matches: Array<ConversationSearchResult & { score: number }> = [];
    for (const conversation of conversations) {
      const messages = this.cache.get(conversation.id)?.messages ?? [];
      const title = fold(conversation.title); const all = title + '\n' + messages.map(message => fold(message.text)).join('\n');
      if (!terms.every(term => all.includes(term))) continue;
      const titleMatch = terms.every(term => title.includes(term));
      let messageIndex = -1; let matchedCount = 0;
      messages.forEach((message, index) => {
        const count = terms.filter(term => fold(message.text).includes(term)).length;
        if (count > 0 && count >= matchedCount) { matchedCount = count; messageIndex = index; }
      });
      const message = messages[messageIndex];
      const score = titleMatch ? title === fold(query.trim()) ? 100 : title.startsWith(terms[0]!) ? 80 : 60 : 20 + matchedCount;
      matches.push({ ...conversation, snippet: message ? snippet(message.text, terms) : '', matchedIn: titleMatch ? 'title' : 'message',
        ...(message ? { messageIndex, messageRole: message.role === 'assistant' ? 'assistant' : 'user' } : {}), score });
    }
    return matches.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt)).map(({ score: _score, ...result }) => result);
  }
  async search(query: string, conversations: ConversationSummary[], signal?: AbortSignal,
    onProgress?: (state: HistorySearchState) => void): Promise<HistorySearchState> {
    signal?.throwIfAborted();
    const ownedIds = new Set(conversations.map(conversation => conversation.id));
    for (const id of this.cache.keys()) if (!ownedIds.has(id)) this.cache.delete(id);
    if (!searchTerms(query).length) return { results: this.peek('', conversations), searched: 0, total: 0, failed: 0 };
    if (this.gateway.searchConversations) {
      const results = await this.gateway.searchConversations(query, signal); signal?.throwIfAborted();
      return { results, searched: results.length, total: results.length, failed: 0 };
    }
    const pending = conversations.filter(conversation => !this.cache.has(conversation.id) || Date.now() - this.cache.get(conversation.id)!.storedAt > 60_000);
    let next = 0; let searched = conversations.length - pending.length; let failed = 0;
    const snapshot = () => ({ results: this.peek(query, conversations), searched, total: conversations.length, failed });
    onProgress?.(snapshot());
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length) {
        signal?.throwIfAborted(); const conversation = pending[next++]!;
        try {
          const history = await this.gateway.getConversation(conversation.id, signal); signal?.throwIfAborted();
          if (history.id !== conversation.id) throw new Error('Unexpected conversation in history search.');
          // A live session may have refreshed this entry while the history request was in flight.
          const existing = this.cache.get(conversation.id);
          if (!existing || Date.now() - existing.storedAt > 60_000) this.cache.set(conversation.id, {
            messages: history.turns.flatMap(turn => [{ text: turn.message, role: 'user' }, { text: turn.text, role: 'assistant' }]), storedAt: Date.now(),
          });
        } catch (error) { signal?.throwIfAborted(); failed++; }
        searched++; onProgress?.(snapshot());
      }
    }));
    signal?.throwIfAborted(); return snapshot();
  }
}
function snippet(text: string, terms: string[]): string {
  const plain = text.replace(/^\s*[`~]{3,}[^\n]*$/gm, '').replace(/[#*_`|>]/g, '').replace(/\s+/g, ' ').trim();
  const normalized = fold(plain); const positions = terms.map(term => normalized.indexOf(term)).filter(index => index >= 0);
  const first = positions.length ? Math.min(...positions) : 0;
  let start = Math.max(0, first - 45);
  if (start > 0) { const boundary = plain.indexOf(' ', start); if (boundary > start && boundary < first) start = boundary + 1; }
  const end = Math.min(plain.length, start + 180);
  return (start ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}
