/** LOCAL DEVELOPMENT ONLY: synthetic answers, a fixed identity, and in-memory ownership storage. */
import { createServer } from 'node:http';
import { createChatGateway, type OwnedConversation } from '../../server/index.js';
import type { ForgeChatEvent, ForgeConversationSnapshot } from '@arveniq/forge-sdk';

const conversations = new Map<string, OwnedConversation>();
const snapshots = new Map<string, ForgeConversationSnapshot>();
const canceled = new Set<string>();
const forge = {
  async createConversation({ agentId }: { agentId: string }) {
    const conversation = { id: crypto.randomUUID(), agentId, createdAt: new Date().toISOString() };
    snapshots.set(conversation.id, { ...conversation, turns: [] }); return conversation;
  },
  async getConversation(id: string) { return snapshots.get(id)!; },
  async *streamMessage(id: string, input: { clientMessageId: string; message: string }, options?: { signal?: AbortSignal }) {
    const snapshot = snapshots.get(id)!;
    let turn = snapshot.turns.find(t => t.clientMessageId === input.clientMessageId);
    if (!turn) { turn = { id: crypto.randomUUID(), ...input, text: '', status: 'running', createdAt: new Date().toISOString() }; snapshot.turns.push(turn); }
    yield demoEvent(id, turn.id, 'turn.accepted', {}, '0');
    yield demoEvent(id, turn.id, 'activity.updated', { message: 'Preparing a demonstration response…' }, '1');
    const answer = `**SAPUI5 integration is ready.**\n\nYou asked: ${input.message}\n\nThis is a local demonstration using synthetic responses. Connect the gateway to your Forge agent to answer from authorized business data.\n\n\`\`\`typescript\ncreateChatPanel({ gateway });\n\`\`\``;
    const words = answer.match(/.{1,24}/gs)!;
    let sequence = 2;
    for (const delta of words) {
      options?.signal?.throwIfAborted();
      if (canceled.has(turn.id)) { turn.status = 'canceled'; yield demoEvent(id, turn.id, 'turn.canceled', { status: 'canceled' }, String(sequence)); return; }
      await new Promise(resolve => setTimeout(resolve, 50)); turn.text += delta;
      yield demoEvent(id, turn.id, 'response.delta', { delta }, String(sequence++));
    }
    turn.text = answer; turn.status = 'completed';
    yield demoEvent(id, turn.id, 'response.completed', { text: answer }, String(sequence++));
    yield demoEvent(id, turn.id, 'turn.completed', { status: 'completed' }, String(sequence));
  },
  async *streamConversationTurn(id: string, turnId: string) {
    const turn = snapshots.get(id)!.turns.find(t => t.id === turnId)!;
    yield demoEvent(id, turnId, 'response.completed', { text: turn.text }, '100000');
    yield demoEvent(id, turnId, turn.status === 'canceled' ? 'turn.canceled' : 'turn.completed', { status: turn.status }, '100001');
  },
  async cancelConversationTurn(conversationId: string, turnId: string) { canceled.add(turnId); return { conversationId, turnId }; },
};
function demoEvent(conversationId: string, turnId: string, type: ForgeChatEvent['type'], data: ForgeChatEvent['data'], sequence: string): ForgeChatEvent {
  return { version: 1, conversationId, turnId, messageId: `${turnId}:assistant`, type, data, sequence, eventId: `${turnId}:${sequence}`, createdAt: new Date().toISOString() };
}
const gateway = createChatGateway({ forge, agentId: 'local-demo',
  authenticate: async () => ({ userId: 'demo-user', tenantId: 'demo-tenant' }),
  verifyMutation: async request => request.headers['x-csrf-token'] === 'local-demo-only',
  getCsrfToken: async () => 'local-demo-only',
  conversations: { list: async () => [...conversations.values()], get: async id => conversations.get(id),
    put: async record => { conversations.set(record.id, record); } },
});
createServer(async (request, response) => { if (!(await gateway(request, response))) { response.writeHead(404); response.end(); } })
  .listen(8091, '127.0.0.1', () => process.stdout.write('LOCAL DEMO gateway at http://127.0.0.1:8091 — synthetic answers; no SAP SSO.\n'));
