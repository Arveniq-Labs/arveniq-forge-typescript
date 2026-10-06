import { reduceChatEvent } from '@arveniq/forge-sdk/chat';
import type { ChatGateway, ChatViewState, ForgeChatEvent, ForgeChatState, SendMessageInput } from './types';

interface ActiveTurn {
  conversationId: string; input: SendMessageInput; assistantId: string;
  stream: ForgeChatState; stopRequested?: boolean;
}
const initial = (): ChatViewState => ({ conversations: [], messages: [], busy: false, status: 'ready', activity: '',
  error: '', approvalRequired: false, canResume: false, canStop: false, attachments: [] });

/** Framework-independent controller; a disconnected view never cancels an executing agent. */
export class ForgeChatSession {
  private state = initial();
  private listeners = new Set<(state: ChatViewState) => void>();
  private active?: ActiveTurn;
  private connection?: AbortController;
  private disposed = false;
  constructor(readonly gateway: ChatGateway) {}
  getState(): ChatViewState { return structuredClone({ ...this.state, canStop: !!this.active }); }
  subscribe(listener: (state: ChatViewState) => void) {
    this.listeners.add(listener); listener(this.getState());
    return () => { this.listeners.delete(listener); };
  }
  async initialize() {
    await this.exclusive(async () => { this.state.conversations = await this.gateway.listConversations(this.connection?.signal); });
  }
  async newConversation() {
    this.assertIdle();
    if (this.active) throw new Error('Resume or cancel the pending turn before starting another chat.');
    await this.exclusive(async () => {
      const conversation = await this.gateway.createConversation(this.connection?.signal);
      this.state.conversations.unshift(conversation);
      this.state.conversationId = conversation.id;
      this.state.messages = []; this.state.attachments = []; this.state.approvalRequired = false;
      this.state.canResume = false; this.state.status = 'ready';
    });
  }
  async selectConversation(id: string) {
    this.assertIdle();
    if (this.active) throw new Error('Resume or cancel the pending turn before switching chats.');
    await this.exclusive(async () => {
      const snapshot = await this.gateway.getConversation(id, this.connection?.signal);
      this.state.conversationId = snapshot.id;
      this.state.attachments = [];
      this.state.messages = snapshot.turns.flatMap(turn => [
        { id: `${turn.id}:user`, role: 'user' as const, text: turn.message },
        { id: `${turn.id}:assistant`, role: 'assistant' as const, text: turn.text, status: turn.status },
      ]);
      const pending = snapshot.turns.find(turn => !['completed', 'succeeded', 'failed', 'canceled', 'cancelled', 'timed_out'].includes(turn.status.toLowerCase()));
      this.active = pending ? { conversationId: id, assistantId: `${pending.id}:assistant`,
        input: { clientMessageId: pending.clientMessageId, message: pending.message },
        stream: { text: '', turnId: pending.id, status: pending.status } } : undefined;
      // A history snapshot has no replay cursor. Resume from zero and rebuild instead of appending.
      this.state.approvalRequired = !!pending && ['approval_required', 'waiting_approval'].includes(pending.status.toLowerCase());
      this.state.canResume = !!pending; this.state.status = pending?.status ?? 'ready';
    });
  }
  async send(message: string) {
    this.assertIdle();
    if (this.active) throw new Error('Resume or cancel the pending turn before sending another message.');
    if (!message.trim()) return;
    await this.exclusive(async () => {
      if (!this.state.conversationId) {
        const conversation = await this.gateway.createConversation(this.connection?.signal);
        this.state.conversations.unshift(conversation); this.state.conversationId = conversation.id;
      }
      const id = crypto.randomUUID();
      const summary = this.state.conversations.find(c => c.id === this.state.conversationId);
      if (summary && this.state.messages.length === 0) summary.title = message.trim().slice(0, 80);
      this.active = { conversationId: this.state.conversationId, assistantId: `${id}:assistant`, stream: { text: '' },
        input: { clientMessageId: id, message: message.trim(), ...(this.state.attachments.length ? { attachmentIds: this.state.attachments.map(a => a.id) } : {}) } };
      this.state.messages.push({ id: `${id}:user`, role: 'user', text: message.trim() },
        { id: this.active.assistantId, role: 'assistant', text: '', status: 'connecting' });
      this.state.attachments = [];
      await this.consume(false);
    });
  }
  async resume() {
    this.assertIdle(); if (!this.active) return;
    await this.exclusive(() => this.consume(!!this.active?.stream.turnId));
  }
  async stop() {
    if (!this.active) return;
    if (!this.active.stream.turnId) {
      this.active.stopRequested = true; this.state.status = 'canceling'; this.emit(); return;
    }
    await this.cancelActive();
  }
  async attach(file: File) {
    this.assertIdle();
    if (this.active) throw new Error('Finish the pending turn before attaching a file.');
    if (!this.gateway.uploadAttachment) throw new Error('Attachments are not enabled by this gateway.');
    await this.exclusive(async () => {
      if (!this.state.conversationId) {
        const conversation = await this.gateway.createConversation(this.connection?.signal);
        this.state.conversations.unshift(conversation); this.state.conversationId = conversation.id;
      }
      const attachment = await this.gateway.uploadAttachment!(this.state.conversationId, file, this.connection?.signal);
      this.state.attachments.push(attachment);
    });
  }
  removeAttachment(id: string) {
    this.assertIdle(); this.state.attachments = this.state.attachments.filter(a => a.id !== id); this.emit();
  }
  dispose() { this.disposed = true; this.connection?.abort(); this.listeners.clear(); }
  private async cancelActive() {
    const active = this.active;
    if (!active?.stream.turnId) return;
    try {
      await this.gateway.cancelTurn(active.conversationId, active.stream.turnId);
      if (this.active !== active) return; // A completion arriving during cancellation keeps its canonical result.
      this.connection?.abort();
      this.state.status = 'canceled'; this.state.activity = ''; this.state.approvalRequired = false;
      this.state.canResume = false;
      const message = this.state.messages.find(m => m.id === active.assistantId);
      if (message) message.status = 'canceled';
      this.active = undefined; this.emit();
    } catch (error) { this.state.error = errorMessage(error); this.emit(); }
  }
  private async consume(resume: boolean) {
    const active = this.active!;
    this.state.status = 'connecting'; this.state.approvalRequired = false; this.state.canResume = false; this.emit();
    const options = { signal: this.connection!.signal, afterEventId: active.stream.lastEventId, afterSequence: active.stream.lastSequence };
    const events = resume ? this.gateway.resumeTurn(active.conversationId, active.stream.turnId!, options)
      : this.gateway.streamMessage(active.conversationId, active.input, options);
    for await (const event of events) {
      if (this.disposed || this.connection?.signal.aborted) return;
      active.stream = reduceChatEvent(active.stream, event);
      this.state.status = active.stream.status ?? 'streaming'; this.state.activity = active.stream.activity ?? '';
      const message = this.state.messages.find(m => m.id === active.assistantId)!;
      message.text = active.stream.text; message.status = this.state.status;
      const citations = safeCitations(event);
      if (citations.length) message.citations = citations;
      this.emit();
      if (active.stopRequested) { await this.cancelActive(); if (!this.active) return; active.stopRequested = false; }
      if (event.type === 'turn.requires_action') {
        this.state.approvalRequired = true; this.state.canResume = true; this.state.activity = event.data.message ?? '';
      } else if (['turn.completed', 'turn.failed', 'turn.canceled'].includes(event.type)) {
        this.active = undefined;
        if (event.type === 'turn.failed') this.state.error = event.data.message ?? 'The assistant could not complete this request.';
      }
      this.emit();
    }
    if (this.active === active && !this.state.approvalRequired && !this.connection?.signal.aborted)
      throw new Error('Connection ended before the turn settled. Resume to recover the response.');
  }
  private async exclusive(operation: () => Promise<void>) {
    this.assertIdle(); this.connection = new AbortController(); this.state.busy = true; this.state.error = ''; this.emit();
    try { await operation(); }
    catch (error) {
      if (!this.disposed && !this.connection.signal.aborted) {
        this.state.error = errorMessage(error); this.state.status = 'interrupted';
        this.state.canResume = !!this.active;
      }
    } finally { this.state.busy = false; this.state.activity = ''; this.emit(); }
  }
  private assertIdle() {
    if (this.disposed) throw new Error('Chat session has been disposed.');
    if (this.state.busy) throw new Error('Wait for the current chat operation to finish.');
  }
  private emit() { if (!this.disposed) for (const listener of this.listeners) listener(this.getState()); }
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Unable to complete this chat request.'; }
function safeCitations(event: ForgeChatEvent) {
  const value = (event.data as Record<string, unknown>).citations;
  if (!Array.isArray(value)) return [];
  return value.flatMap(c => {
    if (!c || typeof c.title !== 'string' || typeof c.url !== 'string') return [];
    try { const url = new URL(c.url); return ['https:', 'http:'].includes(url.protocol) ? [{ title: c.title, url: url.href }] : []; }
    catch { return []; }
  });
}
