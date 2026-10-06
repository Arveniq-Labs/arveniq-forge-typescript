import { readChatEvents, ForgeStreamError } from '@arveniq/forge-sdk/chat';
import type { ChatGateway, ConversationSnapshot, ConversationSummary, ForgeChatEvent, SendMessageInput, StreamOptions } from './types';

export class ChatGatewayError extends Error {
  constructor(public readonly status: number, message: string, public readonly requestId?: string) {
    super(message); this.name = 'ChatGatewayError';
  }
}
export interface GatewayClientOptions {
  /** Same-origin application route, e.g. /api/forge-chat. Never a Forge Developer API URL. */
  baseUrl: string;
  /** Injectable for SSR tests; defaults to the current browser origin. */
  origin?: string;
  fetcher?: typeof fetch;
  /** Obtain a host-issued CSRF token. Called for every mutation, including a retried send. */
  csrfTokenProvider?: () => Promise<string>;
  maxReconnects?: number;
  reconnectDelayMs?: number;
}

/** Browser client for an authenticated, same-origin application gateway. No Developer key option. */
export class ForgeChatGatewayClient implements ChatGateway {
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly reconnects: number;
  private readonly delay: number;
  constructor(private readonly options: GatewayClientOptions) {
    const origin = new URL(options.origin ?? globalThis.location?.origin ?? 'http://localhost').origin;
    this.base = new URL(options.baseUrl, origin);
    if (this.base.origin !== origin || this.base.username || this.base.password || this.base.search || this.base.hash ||
      /\/developer\/v1(?:\/|$)/.test(this.base.pathname)) {
      throw new Error('Use a same-origin application gateway without credentials, query, or fragment.');
    }
    this.base.pathname = this.base.pathname.replace(/\/$/, '');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.reconnects = options.maxReconnects ?? 3;
    this.delay = options.reconnectDelayMs ?? 500;
    if (!Number.isInteger(this.reconnects) || this.reconnects < 0 || !Number.isFinite(this.delay) || this.delay < 0)
      throw new Error('Reconnect settings must be nonnegative; maxReconnects must be an integer.');
  }
  async listConversations(signal?: AbortSignal) {
    return (await this.json('/conversations', { signal }) as { items: ConversationSummary[] }).items;
  }
  async createConversation(signal?: AbortSignal) {
    return await this.json('/conversations', { method: 'POST', body: '{}', signal }) as ConversationSummary;
  }
  async getConversation(id: string, signal?: AbortSignal) {
    return await this.json(`/conversations/${segment(id)}`, { signal }) as ConversationSnapshot;
  }
  streamMessage(id: string, input: SendMessageInput, options: StreamOptions = {}) {
    if (!input.clientMessageId.trim() || !input.message.trim()) throw new Error('Message and stable clientMessageId are required.');
    return this.stream(id, undefined, input, options);
  }
  resumeTurn(id: string, turnId: string, options: StreamOptions = {}) {
    segment(turnId); return this.stream(id, turnId, undefined, options);
  }
  async cancelTurn(id: string, turnId: string) {
    await this.json(`/conversations/${segment(id)}/turns/${segment(turnId)}/cancel`, { method: 'POST', body: '{}' });
  }
  private async *stream(id: string, turnId: string | undefined, input: SendMessageInput | undefined, options: StreamOptions): AsyncIterable<ForgeChatEvent> {
    const base = `/conversations/${segment(id)}`;
    let cursor = options.afterEventId;
    let sequence = options.afterSequence ? sequenceNumber(options.afterSequence) : undefined;
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      try {
        const response = await this.request(turnId ? `${base}/turns/${segment(turnId)}/events` : `${base}/messages`, {
          signal: options.signal,
          ...(turnId ? {} : { method: 'POST', body: JSON.stringify(input) }),
          headers: { Accept: 'text/event-stream', ...(cursor ? { 'Last-Event-ID': cursor } : {}) },
        });
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
          await response.body?.cancel();
          throw new ForgeStreamError('The gateway did not return an event stream.', 'stream_content_type_invalid');
        }
        for await (const event of readChatEvents(response.body)) {
          if (event.conversationId !== id || (turnId && event.turnId !== turnId))
            throw new ForgeStreamError('Unexpected conversation or turn in stream.', 'stream_event_invalid');
          turnId = event.turnId;
          if (event.sequence) {
            const next = sequenceNumber(event.sequence);
            if (sequence !== undefined && next <= sequence) continue;
            sequence = next;
          }
          if (event.eventId) cursor = event.eventId;
          yield event;
          if (settled(event.type)) return;
        }
        throw new ForgeStreamError('Connection ended before the turn settled.');
      } catch (error) {
        options.signal?.throwIfAborted();
        const retryable = error instanceof ChatGatewayError ? error.status === 429 || error.status >= 500
          : error instanceof ForgeStreamError ? ['stream_interrupted', 'developer_stream_interrupted'].includes(error.code)
          : error instanceof TypeError;
        if (!retryable || attempt >= this.reconnects) throw error;
        await pause(Math.min(10_000, this.delay * 2 ** attempt), options.signal);
      }
    }
  }
  private async json(path: string, init: RequestInit) {
    const response = await this.request(path, init);
    return response.status === 204 ? undefined : response.json();
  }
  private async request(path: string, init: RequestInit) {
    const headers = new Headers(init.headers);
    if (init.body) headers.set('Content-Type', 'application/json');
    if (init.method && init.method !== 'GET' && this.options.csrfTokenProvider) {
      headers.set('X-CSRF-Token', await this.options.csrfTokenProvider());
    }
    const response = await this.fetcher(this.base.href + path, { ...init, headers, credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChatGatewayError(response.status, response.status === 401 ? 'Your session has expired. Sign in again.'
        : response.status === 403 ? 'You do not have permission for this conversation.'
        : `Chat request failed (${response.status}).`, response.headers.get('x-request-id') ?? undefined);
    }
    return response;
  }
}
export function settled(type: string) {
  return ['turn.completed', 'turn.failed', 'turn.canceled', 'turn.requires_action'].includes(type);
}
function segment(value: string) {
  if (!value.trim() || value === '.' || value === '..') throw new Error('Conversation and turn identifiers must not be empty or dot segments.');
  return encodeURIComponent(value);
}
function sequenceNumber(value: string) {
  if (!/^\d+$/.test(value)) throw new ForgeStreamError('Invalid event sequence.', 'stream_event_invalid');
  return BigInt(value);
}
async function pause(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
