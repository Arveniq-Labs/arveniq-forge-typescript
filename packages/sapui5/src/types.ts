import type { ForgeChatEvent, ForgeChatState } from '@arveniq/forge-sdk/chat';

export type { ForgeChatEvent, ForgeChatState };
export interface ConversationSummary { id: string; title: string; createdAt: string }
export interface ConversationSearchResult extends ConversationSummary {
  snippet: string;
  matchedIn: 'title' | 'message';
  messageIndex?: number;
  messageRole?: 'user' | 'assistant';
}
export interface Citation { title: string; url: string }
export interface Attachment { id: string; name: string }
export interface ConversationSnapshot {
  id: string; agentId: string; createdAt: string; title?: string;
  turns: Array<{ id: string; clientMessageId: string; status: string; message: string; text: string; createdAt: string }>;
}
export interface SendMessageInput { clientMessageId: string; message: string; attachmentIds?: string[] }
export interface StreamOptions {
  signal?: AbortSignal;
  afterEventId?: string;
  /** Resume sequence for replay deduplication after a view reload. */
  afterSequence?: string;
}
export interface ChatGateway {
  listConversations(signal?: AbortSignal): Promise<ConversationSummary[]>;
  createConversation(signal?: AbortSignal): Promise<ConversationSummary>;
  getConversation(id: string, signal?: AbortSignal): Promise<ConversationSnapshot>;
  /** Optional host full-text search. Apply the same user/tenant scope as history reads. */
  searchConversations?(query: string, signal?: AbortSignal): Promise<ConversationSearchResult[]>;
  streamMessage(id: string, input: SendMessageInput, options?: StreamOptions): AsyncIterable<ForgeChatEvent>;
  resumeTurn(id: string, turnId: string, options?: StreamOptions): AsyncIterable<ForgeChatEvent>;
  cancelTurn(id: string, turnId: string): Promise<void>;
  /** Optional host gateway capability. The default Forge Developer relay supports text only. */
  uploadAttachment?(conversationId: string, file: File, signal?: AbortSignal): Promise<Attachment>;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: string;
  citations?: Citation[];
}
export interface ChatViewState {
  conversations: ConversationSummary[];
  conversationId?: string;
  messages: ChatMessage[];
  busy: boolean;
  status: string;
  activity: string;
  error: string;
  approvalRequired: boolean;
  canResume: boolean;
  canStop: boolean;
  attachments: Attachment[];
}
export interface ChatStrings {
  title: string; newChat: string; history: string; placeholder: string; send: string;
  stop: string; retry: string; resume: string; attach: string; removeAttachment: string;
  welcome: string; welcomeDetail: string; approval: string; openApproval: string;
  assistant: string; you: string; sources: string; emptyHistory: string;
  close: string; working: string; completed: string; canceled: string; failed: string; waitingApproval: string;
  /** Optional labels added in the refined chat UI; defaults preserve existing host translations. */
  subtitle?: string; searchHistory?: string; noHistoryResults?: string; suggestions?: string; composerHint?: string;
  footer?: string; copy?: string; copied?: string; copyUnavailable?: string; latest?: string;
  today?: string; yesterday?: string; connecting?: string; responding?: string; loading?: string; interrupted?: string; canceling?: string;
  searching?: string; searchPartial?: string; searchFailed?: string; searchHint?: string; searchResults?: string; searchResult?: string;
  tableLabel?: string; tableHint?: string; chartData?: string; chartPending?: string; chartInvalid?: string;
}
