import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { ForgeApiError, type ForgeDeveloperClient } from '@arveniq/forge-sdk';

export interface ChatPrincipal { userId: string; tenantId: string }
export interface OwnedConversation {
  id: string; title: string; createdAt: string; userId: string; tenantId: string;
}
export interface ConversationStore {
  list(principal: ChatPrincipal): Promise<OwnedConversation[]>;
  get(id: string): Promise<OwnedConversation | undefined>;
  put(record: OwnedConversation): Promise<void>;
}
export interface ChatGatewayOptions {
  forge: Pick<ForgeDeveloperClient, 'createConversation' | 'getConversation' | 'streamMessage' | 'streamConversationTurn' | 'cancelConversationTurn'>;
  agentId: string;
  conversations: ConversationStore;
  /** Verify your SAP/IAS/XSUAA application session. Never trust user or tenant headers from the browser. */
  authenticate(request: IncomingMessage): Promise<ChatPrincipal | null>;
  /** Required CSRF/origin check supplied by the host (or verified bearer-token authentication). */
  verifyMutation(request: IncomingMessage, principal: ChatPrincipal): Promise<boolean>;
  /** Optional host CSRF issuance. Omit when the SAP application router issues the token. */
  getCsrfToken?(request: IncomingMessage, principal: ChatPrincipal): Promise<string>;
  prefix?: string;
}

/** Node/CAP-compatible relay. The host owns authentication, CSRF, persistence, and Forge secrets. */
export function createChatGateway(options: ChatGatewayOptions) {
  const prefix = (options.prefix ?? '/api/forge-chat').replace(/\/$/, '');
  if (!options.agentId.trim() || !prefix.startsWith('/')) throw new Error('agentId and an absolute gateway prefix are required.');
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const path = new URL(request.url ?? '/', 'http://gateway.invalid').pathname;
    if (path !== prefix && !path.startsWith(prefix + '/')) return false;
    response.setHeader('Cache-Control', 'no-store');
    const connection = new AbortController();
    const disconnected = () => connection.abort();
    response.on('close', disconnected);
    try {
      const principal = await options.authenticate(request);
      if (!principal?.userId || !principal.tenantId) throw new GatewayHttpError(401);
      if (request.method !== 'GET' && !(await options.verifyMutation(request, principal))) throw new GatewayHttpError(403);
      const segments = path.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
      if (segments.length === 1 && segments[0] === 'csrf' && request.method === 'GET') {
        if (options.getCsrfToken) response.setHeader('X-CSRF-Token', await options.getCsrfToken(request, principal));
        response.writeHead(204); response.end(); return true;
      }
      if (segments[0] !== 'conversations') throw new GatewayHttpError(404);
      if (segments.length === 1) {
        if (request.method === 'GET') {
          const records = await options.conversations.list(principal);
          json(response, 200, { items: records.filter(r => owns(principal, r)).map(summary) });
        } else if (request.method === 'POST') {
          const body = await readBody(request); if (Object.keys(body).length) throw new GatewayHttpError(400);
          const conversation = await options.forge.createConversation({ agentId: options.agentId }, { signal: connection.signal });
          const record = { ...principal, id: conversation.id, title: 'New conversation', createdAt: conversation.createdAt };
          await options.conversations.put(record); json(response, 201, summary(record));
        } else throw new GatewayHttpError(405);
        return true;
      }
      const id = segments[1]!;
      const record = await options.conversations.get(id);
      if (!record || !owns(principal, record)) throw new GatewayHttpError(404);
      if (segments.length === 2 && request.method === 'GET') {
        const snapshot = await options.forge.getConversation(id, { signal: connection.signal });
        json(response, 200, { ...snapshot, title: record.title }); return true;
      }
      if (segments.length === 3 && segments[2] === 'messages' && request.method === 'POST') {
        const body = await readBody(request);
        if (body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) || body.attachmentIds.length)) throw new GatewayHttpError(501);
        if (Object.keys(body).some(key => !['clientMessageId', 'message', 'attachmentIds'].includes(key)) ||
          typeof body.clientMessageId !== 'string' || !body.clientMessageId.trim() || body.clientMessageId.length > 200 ||
          typeof body.message !== 'string' || !body.message.trim() || body.message.length > 32_000) throw new GatewayHttpError(400);
        if (record.title === 'New conversation') { record.title = body.message.trim().slice(0, 80); await options.conversations.put(record); }
        await relay(options.forge.streamMessage(id, { clientMessageId: body.clientMessageId, message: body.message },
          { signal: connection.signal }), response, connection.signal);
        return true;
      }
      if (segments.length === 5 && segments[2] === 'turns') {
        const turnId = segments[3]!;
        if (segments[4] === 'events' && request.method === 'GET') {
          const cursor = request.headers['last-event-id'];
          if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 512)) throw new GatewayHttpError(400);
          await relay(options.forge.streamConversationTurn(id, turnId, { signal: connection.signal, afterEventId: cursor }), response, connection.signal);
        } else if (segments[4] === 'cancel' && request.method === 'POST') {
          const body = await readBody(request); if (Object.keys(body).length) throw new GatewayHttpError(400);
          await options.forge.cancelConversationTurn(id, turnId, { signal: connection.signal });
          response.writeHead(204); response.end();
        } else throw new GatewayHttpError(404);
        return true;
      }
      throw new GatewayHttpError(404);
    } catch (error) {
      if (connection.signal.aborted) return true;
      if (response.headersSent) {
        response.end('event: error\ndata: {"type":"error","code":"developer_stream_interrupted","message":"Chat connection interrupted."}\n\n');
      } else {
        const status = error instanceof GatewayHttpError ? error.status
          : error instanceof ForgeApiError ? (error.status >= 400 && error.status <= 599 ? error.status : 502)
          : error instanceof URIError ? 400 : 500;
        json(response, status, { error: status === 501 ? 'This gateway supports text chat only.' : 'Chat request could not be completed.' });
      }
      return true;
    } finally { response.removeListener('close', disconnected); }
  };
}
class GatewayHttpError extends Error { constructor(readonly status: number) { super(`Gateway request failed (${status}).`); } }
function owns(principal: ChatPrincipal, record: OwnedConversation) { return principal.userId === record.userId && principal.tenantId === record.tenantId; }
function summary(record: OwnedConversation) { return { id: record.id, title: record.title, createdAt: record.createdAt }; }
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new GatewayHttpError(415);
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) { request.resume(); throw new GatewayHttpError(413); }
    chunks.push(buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new GatewayHttpError(400); }
}
async function relay(events: AsyncIterable<unknown>, response: ServerResponse, signal: AbortSignal) {
  const iterator = events[Symbol.asyncIterator]();
  let event = await iterator.next(); // Preserve HTTP auth/errors until the first event succeeds.
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  response.flushHeaders();
  const heartbeat = setInterval(() => {
    if (!signal.aborted && !response.destroyed && !response.writableNeedDrain) response.write(': heartbeat\n\n');
  }, 15_000);
  heartbeat.unref();
  try {
    while (!event.done) {
      signal.throwIfAborted();
      if (!response.write(`data: ${JSON.stringify(event.value)}\n\n`)) await once(response, 'drain', { signal });
      event = await iterator.next();
    }
    response.end();
  } finally { clearInterval(heartbeat); await iterator.return?.(); }
}
