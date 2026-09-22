/** A signed, expiring capability that a trusted backend minted after authorizing application context. */
export interface ContextAssertion {
  readonly value: string;
}

/** Creates an opaque assertion envelope; the client must never inspect or derive its authority. */
export function createContextAssertion(value: string): ContextAssertion {
  if (value.trim().length < 32 || value.length > 16_384) {
    throw new MobileProtocolError('A context assertion must be a non-empty opaque value between 32 and 16384 characters.');
  }
  return Object.freeze({ value });
}

export interface MobileCredentialProvider {
  /** Returns a short-lived, audience-bound token issued by the mobile integration gateway or its backend. */
  getAccessToken(): Promise<string | null>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ForgeMobileClientOptions {
  /** HTTPS base URL of the customer backend relay or Forge mobile integration gateway, including /v1. */
  baseUrl: string;
  credentialProvider: MobileCredentialProvider;
  fetcher?: FetchLike;
}

export interface MobileSession {
  id: string;
  expiresAt: string;
}

export interface MobileConversation {
  id: string;
  createdAt: string;
}

export interface CreateConversationInput {
  /** An application-approved alias, not an authoritative Forge identifier. */
  agentHandle?: string;
  contextAssertion: ContextAssertion;
}

export interface StreamMessageInput {
  clientMessageId: string;
  message: string;
  contextAssertion: ContextAssertion;
  /** Resume cursor from a previously persisted gateway event. */
  afterEventId?: string;
  signal?: AbortSignal;
}

export interface ForgeMobileEvent {
  id: string;
  type: string;
  conversationId: string;
  turnId: string;
  messageId?: string;
  sequence: string;
  data: Record<string, unknown>;
}

export interface UploadPreparation {
  attachmentId: string;
  uploadUrl: string;
  requiredHeaders?: Record<string, string>;
  expiresAt: string;
}

export interface PrepareUploadInput {
  filename: string;
  contentType: string;
  byteLength: number;
  contextAssertion: ContextAssertion;
}

export type PushPlatform = 'android' | 'ios';

export class MobileProtocolError extends Error {
  override name = 'MobileProtocolError';
}

export class MobileAuthenticationError extends MobileProtocolError {
  override name = 'MobileAuthenticationError';
}

export class MobileGatewayError extends MobileProtocolError {
  readonly status: number;
  readonly requestId: string | null;

  constructor(status: number, message: string, requestId: string | null) {
    super(message);
    this.name = 'MobileGatewayError';
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * Mobile-safe API client. Its only authorization header is a short-lived gateway bearer token.
 * Forge Developer keys and raw authoritative context IDs are intentionally absent from this API.
 */
export class ForgeMobileClient {
  readonly #baseUrl: URL;
  readonly #credentialProvider: MobileCredentialProvider;
  readonly #fetcher: FetchLike;

  constructor(options: ForgeMobileClientOptions) {
    this.#baseUrl = validateGatewayUrl(options.baseUrl);
    this.#credentialProvider = options.credentialProvider;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async createSession(): Promise<MobileSession> {
    return this.#json('POST', '/mobile/sessions') as Promise<MobileSession>;
  }

  async createConversation(input: CreateConversationInput): Promise<MobileConversation> {
    return this.#json('POST', '/conversations', {
      agentHandle: input.agentHandle,
      contextAssertion: input.contextAssertion,
    }) as Promise<MobileConversation>;
  }

  async prepareUpload(input: PrepareUploadInput): Promise<UploadPreparation> {
    return this.#json('POST', '/uploads:prepare', input) as Promise<UploadPreparation>;
  }

  async registerPushToken(platform: PushPlatform, token: string): Promise<void> {
    if (token.trim().length === 0) throw new MobileProtocolError('A push token is required.');
    await this.#request('PUT', '/devices/push-tokens', { platform, token });
  }

  async cancelConversationTurn(conversationId: string, turnId: string): Promise<void> {
    await this.#request('POST', `/conversations/${encodeURIComponent(conversationId)}/turns/${encodeURIComponent(turnId)}:cancel`);
  }

  async *streamMessage(conversationId: string, input: StreamMessageInput): AsyncIterable<ForgeMobileEvent> {
    if (input.message.trim().length === 0) throw new MobileProtocolError('A message is required.');
    const response = await this.#request(
      'POST',
      `/conversations/${encodeURIComponent(conversationId)}/messages:stream`,
      {
        clientMessageId: input.clientMessageId,
        message: input.message,
        contextAssertion: input.contextAssertion,
      },
      { Accept: 'text/event-stream', ...(input.afterEventId ? { 'Last-Event-ID': input.afterEventId } : {}) },
      input.signal,
    );
    if (!response.body) throw new MobileProtocolError('The gateway returned an empty event stream.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseEvent(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) break;
    }
    const trailing = parseSseEvent(buffer);
    if (trailing) yield trailing;
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await this.#request(method, path, body);
    if (response.status === 204) return undefined;
    return response.json();
  }

  async #request(method: string, path: string, body?: unknown, headers: HeadersInit = {}, signal?: AbortSignal): Promise<Response> {
    const accessToken = await this.#credentialProvider.getAccessToken();
    if (!accessToken?.trim()) throw new MobileAuthenticationError('The mobile integration gateway requires a short-lived access token.');
    const response = await this.#fetcher(new URL(path, this.#baseUrl), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MobileGatewayError(response.status, detail || `Gateway request failed with ${response.status}.`, response.headers.get('x-request-id'));
    }
    return response;
  }
}

function validateGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.endsWith('/') ? value : `${value}/`);
  } catch {
    throw new MobileProtocolError('baseUrl must be an absolute HTTPS gateway URL.');
  }
  const localHttp = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) throw new MobileProtocolError('baseUrl must use HTTPS outside local development.');
  return url;
}

function parseSseEvent(frame: string): ForgeMobileEvent | undefined {
  const fields = new Map<string, string>();
  for (const line of frame.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trimStart();
    fields.set(key, key === 'data' && fields.has(key) ? `${fields.get(key)}\n${value}` : value);
  }
  const serialized = fields.get('data');
  if (!serialized) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(serialized);
  } catch {
    throw new MobileProtocolError('The gateway emitted an invalid JSON SSE event.');
  }
  if (!payload || typeof payload !== 'object') throw new MobileProtocolError('The gateway emitted an invalid SSE event payload.');
  const event = payload as Partial<ForgeMobileEvent>;
  const eventType = event.type ?? fields.get('event');
  if (!eventType || !event.id || !event.conversationId || !event.turnId || !event.sequence || !event.data || typeof event.data !== 'object') {
    throw new MobileProtocolError('The gateway emitted an incomplete SSE event.');
  }
  return { ...event, type: eventType, data: event.data as Record<string, unknown> } as ForgeMobileEvent;
}
