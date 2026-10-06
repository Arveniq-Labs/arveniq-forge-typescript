import './library';
import JSONModel from 'sap/ui/model/json/JSONModel';
import HBox from 'sap/m/HBox';
import VBox from 'sap/m/VBox';
import Text from 'sap/m/Text';
import Title from 'sap/m/Title';
import Button from 'sap/m/Button';
import TextArea from 'sap/m/TextArea';
import SearchField from 'sap/m/SearchField';
import List from 'sap/m/List';
import CustomListItem from 'sap/m/CustomListItem';
import HTML from 'sap/ui/core/HTML';
import Link from 'sap/m/Link';
import MessageStrip from 'sap/m/MessageStrip';
import MessageToast from 'sap/m/MessageToast';
import Toolbar from 'sap/m/Toolbar';
import ToolbarSpacer from 'sap/m/ToolbarSpacer';
import ScrollContainer from 'sap/m/ScrollContainer';
import FlexItemData from 'sap/m/FlexItemData';
import Page from 'sap/m/Page';
import Dialog from 'sap/m/Dialog';
import Icon from 'sap/ui/core/Icon';
import InvisibleText from 'sap/ui/core/InvisibleText';
import CustomData from 'sap/ui/core/CustomData';
import type Context from 'sap/ui/model/Context';
import { ForgeChatSession } from './session';
import { formatAnswer } from './format';
import { ChatHistorySearch } from './search';
import { highlightMatches } from './markup';
import type { ChatGateway, ChatStrings, ChatViewState, ConversationSearchResult } from './types';

export const defaultStrings = {
  title: 'Ask Forge AI', newChat: 'New chat', history: 'Conversations', placeholder: 'Ask Forge AI a question…',
  send: 'Send', stop: 'Stop', retry: 'Retry', resume: 'Resume response', attach: 'Attach file', removeAttachment: 'Remove',
  welcome: 'How can I help you today?', welcomeDetail: 'Turn questions into clarity. Explore information and move your work forward.',
  approval: 'This request needs approval before it can continue.', openApproval: 'Review approval',
  assistant: 'Forge AI', you: 'You', sources: 'Sources', emptyHistory: 'Your conversations will appear here.',
  close: 'Close', working: 'Working…', completed: 'Completed', canceled: 'Response stopped', failed: 'Response failed', waitingApproval: 'Waiting for approval',
  subtitle: 'Your business assistant', searchHistory: 'Search chats…', noHistoryResults: 'No matching conversations.',
  suggestions: 'Try a starting point', composerHint: 'Enter to send · Shift+Enter for a new line',
  footer: 'AI can make mistakes. Review important information.', copy: 'Copy response', copied: 'Response copied',
  copyUnavailable: 'Unable to copy. Select the response text to copy it.', latest: 'Jump to latest',
  today: 'Today', yesterday: 'Yesterday', connecting: 'Connecting…', responding: 'Writing a response…',
  loading: 'Loading conversation…', interrupted: 'Response paused. Resume to continue.', canceling: 'Stopping…',
  searching: 'Searching messages…', searchPartial: 'Some chats could not be searched. Search again to retry.',
  searchFailed: 'Search could not finish. Please try again.', searchHint: 'Search titles & messages · Ctrl/⌘ K', searchResults: '{count} matches', searchResult: '{count} match',
  tableLabel: 'Response table', tableHint: 'Scroll horizontally to see all columns.', chartData: 'View chart data',
  chartPending: 'Preparing chart…', chartInvalid: 'Unable to display this chart. Check the chart data below.',
} satisfies ChatStrings;
export interface ChatPanelOptions {
  gateway: ChatGateway;
  session?: ForgeChatSession;
  title?: string;
  showHistory?: boolean;
  suggestions?: string[];
  strings?: Partial<ChatStrings>;
  /** Host opens its authorized approval workflow. Resume is separate; this callback grants no approval. */
  onApprovalRequested?: (conversationId: string) => void;
  onError?: (error: unknown) => void;
}
export interface ChatPanelHandle {
  control: HBox;
  model: JSONModel;
  session: ForgeChatSession;
  ready: Promise<void>;
  destroy(): void;
}

/** Ready-to-use SAPUI5 chat UI. Embed the returned control in any container. Destroy the handle on host exit. */
export function createChatPanel(options: ChatPanelOptions): ChatPanelHandle {
  const strings = { ...defaultStrings, ...options.strings, ...(options.title ? { title: options.title } : {}) };
  const session = options.session ?? new ForgeChatSession(options.gateway);
  const model = new JSONModel(session.getState());
  const viewModel = new JSONModel({ draft: '', notice: '', historyQuery: '', historyItems: [], searching: false, searchError: '', awayFromLatest: false, canceling: false });
  viewModel.setSizeLimit(1000);
  const searchIndex = new ChatHistorySearch(options.gateway);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let searchAbort: AbortController | undefined;
  let searchVersion = 0;
  let pendingSearchHit: { conversationId: string; messageIndex: number } | undefined;
  model.setSizeLimit(1000);
  let destroyed = false;
  let historyDialog: Dialog;
  let mobileHistory: List;
  let submittedDraft: { text: string; userCount: number } | undefined;
  const run = (action: () => Promise<void> | void) => {
    viewModel.setProperty('/notice', '');
    Promise.resolve().then(() => { if (!destroyed) return action(); }).catch(error => {
      if (!destroyed) {
        viewModel.setProperty('/notice', error instanceof Error ? error.message : strings.failed);
        options.onError?.(error);
      }
    });
  };
  const idleBinding = () => ({ parts: [{ path: 'forge>/busy' }, { path: 'forge>/canResume' }],
    formatter: (busy: boolean, pending: boolean) => !busy && !pending });
  const composer = new TextArea({ width: '100%', rows: 2, growing: true, growingMaxLines: 6,
    value: '{forgeUI>/draft}', valueLiveUpdate: true, placeholder: strings.placeholder, enabled: idleBinding() }).addStyleClass('forgeChatInput');
  const composerLabel = new InvisibleText({ text: strings.placeholder });
  composer.addAriaLabelledBy(composerLabel);
  const submit = () => {
    const state = session.getState(); const text = composer.getValue();
    if (!text.trim() || state.busy || state.canResume || submittedDraft) return;
    viewModel.setProperty('/draft', text);
    submittedDraft = { text, userCount: state.messages.filter(message => message.role === 'user').length };
    run(async () => { try { await session.send(text); } finally { submittedDraft = undefined; } });
  };
  composer.addEventDelegate({ onkeydown: (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && composer.getEnabled()) { event.preventDefault(); submit(); }
  } });
  const startNewChat = () => run(async () => {
    const before = session.getState().conversationId;
    await session.newConversation();
    if (session.getState().conversationId !== before) { viewModel.setProperty('/draft', ''); composer.focus(); }
  });
  const dateLabel = (value: string) => {
    const date = new Date(value); if (!Number.isFinite(date.getTime())) return '';
    const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return strings.today;
    if (date.toDateString() === yesterday.toDateString()) return strings.yesterday;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  };
  const history = new List({ mode: { parts: [{ path: 'forge>/busy' }, { path: 'forge>/canResume' }],
    formatter: (busy: boolean, pending: boolean) => busy || pending ? 'None' : 'SingleSelectMaster' },
    noDataText: strings.emptyHistory, showSeparators: 'None', includeItemInSelection: true,
    itemPress: event => {
      const result = event.getParameter('listItem')?.getBindingContext('forgeUI')?.getObject() as ConversationSearchResult | undefined;
      const state = session.getState();
      if (!result || state.busy || state.canResume) return;
      historyDialog?.close();
      pendingSearchHit = result.messageIndex !== undefined && viewModel.getProperty('/historyQuery')
        ? { conversationId: result.id, messageIndex: result.messageIndex } : undefined;
      if (pendingSearchHit) followLatest = false;
      if (result.id !== state.conversationId) run(async () => {
        await session.selectConversation(result.id);
        if (session.getState().conversationId === result.id) viewModel.setProperty('/draft', ''); else pendingSearchHit = undefined;
      }); else scheduleScroll();
    } }).addStyleClass('forgeChatHistory');
  const highlightName = (text: string, query: string) => '<div class="forgeChatSearchText forgeChatHistoryName">' + highlightMatches(text?.split(/\r?\n/)[0] || '', query || '') + '</div>';
  const highlightSnippet = (text: string, query: string) => '<div class="forgeChatSearchText forgeChatHistorySnippet">' + highlightMatches(text || '', query || '') + '</div>';
  history.bindAggregation('items', { path: 'forgeUI>/historyItems', factory: (_id: string, _context: Context) =>
    new CustomListItem({ type: 'Active', selected: { parts: [{ path: 'forgeUI>id' }, { path: 'forge>/conversationId' }],
      formatter: (id: string, current?: string) => id === current }, content: [new VBox({ items: [
        new HTML({ preferDOM: false, sanitizeContent: false, content: { parts: [{ path: 'forgeUI>title' }, { path: 'forgeUI>/historyQuery' }], formatter: highlightName } }),
        new Text({ text: { parts: [{ path: 'forgeUI>createdAt' }, { path: 'forgeUI>messageRole' }, { path: 'forgeUI>/historyQuery' }],
          formatter: (date: string, role?: string, query?: string) => dateLabel(date) + (query && role ? ' · ' + (role === 'assistant' ? strings.assistant : strings.you) : '') } }).addStyleClass('forgeChatHistoryMeta'),
        new HTML({ preferDOM: false, sanitizeContent: false, visible: { parts: [{ path: 'forgeUI>snippet' }, { path: 'forgeUI>/historyQuery' }], formatter: (text: string, query: string) => !!text && !!query },
          content: { parts: [{ path: 'forgeUI>snippet' }, { path: 'forgeUI>/historyQuery' }], formatter: highlightSnippet } }),
      ] }).addStyleClass('forgeChatHistoryRow')] }).addCustomData(new CustomData({ key: 'current', writeToDom: true, value: {
        parts: [{ path: 'forgeUI>id' }, { path: 'forge>/conversationId' }], formatter: (id: string, current?: string) => id === current ? 'true' : 'false',
      } })) });
  const updateHistory = (results: ConversationSearchResult[]) => {
    viewModel.setProperty('/historyItems', results);
    for (const list of [history, mobileHistory]) if (list) list.setNoDataText(viewModel.getProperty('/searching') ? strings.searching
      : viewModel.getProperty('/historyQuery') ? strings.noHistoryResults : strings.emptyHistory);
  };
  const queueSearch = (query: string, immediate = false) => {
    const version = ++searchVersion; if (searchTimer) clearTimeout(searchTimer); searchAbort?.abort();
    viewModel.setProperty('/historyQuery', query); viewModel.setProperty('/searchError', '');
    viewModel.setProperty('/searching', !!query.trim()); updateHistory(searchIndex.peek(query, session.getState().conversations));
    if (!query.trim()) return;
    searchTimer = setTimeout(() => {
      searchAbort = new AbortController();
      const current = () => !destroyed && version === searchVersion;
      searchIndex.search(query, session.getState().conversations, searchAbort.signal, progress => { if (current()) updateHistory(progress.results); })
        .then(result => { if (current()) { updateHistory(result.results); viewModel.setProperty('/searchError', result.failed ? strings.searchPartial : ''); } })
        .catch(() => { if (current()) viewModel.setProperty('/searchError', strings.searchFailed); })
        .finally(() => { if (current()) { viewModel.setProperty('/searching', false); updateHistory(viewModel.getProperty('/historyItems')); } });
    }, immediate ? 0 : 250);
  };
  const historySearch = new SearchField({ width: '100%', maxLength: 200, placeholder: strings.searchHistory, showSearchButton: false,
    value: '{forgeUI>/historyQuery}', liveChange: event => queueSearch(event.getParameter('newValue') ?? ''),
    search: event => queueSearch(event.getParameter('query') ?? '', true) });
  const searchStatus = new Text({ text: { parts: [{ path: 'forgeUI>/historyQuery' }, { path: 'forgeUI>/historyItems' },
    { path: 'forgeUI>/searching' }, { path: 'forgeUI>/searchError' }], formatter: (query: string, items: unknown[], searching: boolean, error: string) =>
      error || (searching ? strings.searching : query ? (items.length === 1 ? strings.searchResult : strings.searchResults).replace('{count}', String(items.length)) : strings.searchHint) } }).addStyleClass('forgeChatSearchStatus');
  searchStatus.addEventDelegate({ onAfterRendering: () => { searchStatus.getDomRef()?.setAttribute('role', 'status'); } });
  const historyPane = new VBox({ height: '100%', items: [historySearch, searchStatus,
    new ScrollContainer({ width: '100%', height: '100%', vertical: true, content: [history],
      layoutData: new FlexItemData({ growFactor: 1, baseSize: '0%' }) })],
    layoutData: new FlexItemData({ growFactor: 1, baseSize: '0%', minHeight: '0' }) }).addStyleClass('forgeChatHistoryPane');
  const sidebar = new VBox({ width: '17rem', height: '100%', visible: options.showHistory !== false, items: [
    new HBox({ alignItems: 'Center', items: [new Icon({ src: 'sap-icon://discussion', decorative: true }),
      new Text({ text: strings.title })] }).addStyleClass('forgeChatSidebarBrand'),
    new Button({ text: strings.newChat, icon: 'sap-icon://add', type: 'Emphasized', width: '100%', enabled: idleBinding(), press: startNewChat }),
    new Title({ text: strings.history, level: 'H2' }).addStyleClass('forgeChatHistoryTitle'), historyPane,
  ] }).addStyleClass('forgeChatSidebar');
  const welcome = new VBox({ alignItems: 'Center', justifyContent: 'Center', items: [
    new Icon({ src: 'sap-icon://discussion', decorative: true }).addStyleClass('forgeChatWelcomeIcon'),
    new Title({ text: strings.welcome, level: 'H2', textAlign: 'Center', wrapping: true }).addStyleClass('forgeChatWelcomeTitle'),
    new Text({ text: strings.welcomeDetail, textAlign: 'Center' }).addStyleClass('forgeChatWelcomeDetail'),
    new Text({ text: strings.suggestions }).addStyleClass('forgeChatSuggestionsLabel'),
    new HBox({ wrap: 'Wrap', justifyContent: 'Center', items: (options.suggestions ?? [
      'What can you help me with?', 'Summarize business information', 'Help me prepare for a meeting',
    ]).map((text, index) => new Button({ text, width: '100%', type: 'Transparent',
      icon: ['sap-icon://lightbulb', 'sap-icon://document-text', 'sap-icon://calendar'][index % 3],
      layoutData: new FlexItemData({ growFactor: 1, baseSize: '11rem', minWidth: '0' }),
      enabled: idleBinding(), press: () => { viewModel.setProperty('/draft', text); composer.focus(); } }).addStyleClass('forgeChatSuggestion'))
    }).addStyleClass('forgeChatSuggestions'),
  ], visible: { path: 'forge>/messages', formatter: (messages: unknown[]) => messages.length === 0 } }).addStyleClass('forgeChatWelcome');
  const transcript = new List({ showSeparators: 'None', showNoData: false, width: '100%' }).addStyleClass('forgeChatMessages');
  transcript.bindAggregation('items', { path: 'forge>/messages', factory: (_id: string, context: Context) => {
    const assistant = context.getProperty('role') === 'assistant';
    const sources = new HBox({ wrap: 'Wrap', alignItems: 'Center', items: [new Text({ text: strings.sources + ':' })],
      visible: { path: 'forge>citations', formatter: (citations?: unknown[]) => !!citations?.length } }).addStyleClass('forgeChatSources');
    const links = new HBox({ wrap: 'Wrap' });
    links.bindAggregation('items', { path: 'forge>citations', templateShareable: false,
      template: new Link({ text: '{forge>title}', href: '{forge>url}', target: '_blank' }).addStyleClass('sapUiTinyMarginEnd') });
    sources.addItem(links);
    const copy = new Button({ icon: 'sap-icon://copy', type: 'Transparent', tooltip: strings.copy,
      visible: { parts: [{ path: 'forge>text' }, { path: 'forge>status' }], formatter: (text: string, status?: string) =>
        assistant && !!text && ['completed', 'succeeded', 'canceled', 'cancelled', 'failed', 'timed_out'].includes(status?.toLowerCase() ?? '') },
      press: () => run(async () => {
        try { await navigator.clipboard.writeText(context.getProperty('text') as string); MessageToast.show(strings.copied); }
        catch { throw new Error(strings.copyUnavailable); }
      }) });
    const header = new HBox({ alignItems: 'Center', justifyContent: 'SpaceBetween', items: [
      new HBox({ alignItems: 'Center', items: [
        new Icon({ src: assistant ? 'sap-icon://discussion' : 'sap-icon://person-placeholder', decorative: true }).addStyleClass('forgeChatAvatar'),
        new Text({ text: assistant ? strings.assistant : strings.you }).addStyleClass('forgeChatSpeaker'),
      ] }), copy,
    ] }).addStyleClass('forgeChatMessageHeader');
    const status = new Text({ text: { parts: [{ path: 'forge>status' }, { path: 'forge>/canResume' }, { path: 'forge>/busy' }],
      formatter: (value?: string, pending?: boolean, busy?: boolean) => {
        const current = value?.toLowerCase() ?? '';
        if (['completed', 'succeeded'].includes(current)) return '';
        if (['canceled', 'cancelled'].includes(current)) return strings.canceled;
        if (['approval_required', 'waiting_approval'].includes(current)) return strings.waitingApproval;
        if (['failed', 'timed_out'].includes(current)) return strings.failed;
        if (pending && !busy) return strings.interrupted;
        return current === 'connecting' ? strings.connecting : strings.responding;
      } }, visible: { path: 'forge>status', formatter: (value?: string) => assistant && !!value && !['completed', 'succeeded'].includes(value.toLowerCase()) } })
      .addStyleClass('forgeChatStatus');
    let markdownBody: HTML | undefined;
    let horizontalPositions: number[] = [];
    if (assistant) {
      // formatAnswer disables raw HTML and emits only escaped Markdown and validated, data-only SVG charts.
      markdownBody = new HTML({ preferDOM: false, sanitizeContent: false, content: { path: 'forge>text', formatter: (text: string) => {
        horizontalPositions = [...(markdownBody?.getDomRef()?.querySelectorAll<HTMLElement>('.forgeMarkdownTableScroll') ?? [])].map(table => table.scrollLeft);
        return formatAnswer(text, strings);
      } } });
      markdownBody.attachAfterRendering(() => {
        markdownBody?.getDomRef()?.querySelectorAll<HTMLElement>('.forgeMarkdownTableScroll').forEach((table, index) => { table.scrollLeft = horizontalPositions[index] ?? 0; });
      });
    }
    const body = markdownBody ?? new Text({ text: '{forge>text}', renderWhitespace: true });
    return new CustomListItem({ content: [new VBox({ items: [header, body, status, sources] })
      .addStyleClass(assistant ? 'forgeChatMessage forgeChatAssistant' : 'forgeChatMessage forgeChatUser')] });
  } });
  const scroll = new ScrollContainer({ width: '100%', height: '100%', vertical: true,
    layoutData: new FlexItemData({ growFactor: 1, baseSize: '0%', minHeight: '0' }), content: [welcome, transcript] }).addStyleClass('forgeChatTranscript');
  let followLatest = true;
  let scrollFrame: number | undefined;
  const scrollToLatest = () => {
    followLatest = true; viewModel.setProperty('/awayFromLatest', false); scroll.scrollTo(0, 1_000_000, 0);
  };
  const scheduleScroll = () => {
    if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = undefined; if (destroyed) return;
      if (pendingSearchHit && session.getState().conversationId === pendingSearchHit.conversationId && !session.getState().busy) {
        const item = transcript.getItems()[pendingSearchHit.messageIndex]; const viewport = scroll.getDomRef(); const node = item?.getDomRef();
        if (!item && session.getState().messages.length <= pendingSearchHit.messageIndex) { pendingSearchHit = undefined; scrollToLatest(); }
        else if (node && viewport) {
          transcript.getItems().forEach(row => row.removeStyleClass('forgeChatSearchTarget'));
          item!.addStyleClass('forgeChatSearchTarget');
          scroll.scrollTo(0, node.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - 16, 0);
          pendingSearchHit = undefined; followLatest = false; onScroll();
        }
      } else if (followLatest) scrollToLatest();
      if (!session.getState().busy && !session.getState().canResume) for (const list of [history, mobileHistory]) {
        const current = list.getItems().find(item => item.getBindingContext('forgeUI')?.getProperty('id') === session.getState().conversationId);
        if (current) list.setSelectedItem(current, true);
      }
    });
  };
  // Listen on the rendered scroll viewport. A reader scrolling up keeps their place as tokens arrive.
  const onScroll = () => {
    const viewport = scroll.getDomRef() as HTMLElement | null;
    if (!viewport) return;
    followLatest = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
    viewModel.setProperty('/awayFromLatest', !followLatest);
  };
  const resizeObserver = new ResizeObserver(() => { if (followLatest) scheduleScroll(); else onScroll(); });
  scroll.addEventDelegate({ onAfterRendering: () => {
    const node = scroll.getDomRef();
    if (node) { node.addEventListener('scroll', onScroll, { passive: true }); resizeObserver.observe(node); }
    scheduleScroll();
  }, onBeforeRendering: () => { resizeObserver.disconnect(); scroll.getDomRef()?.removeEventListener('scroll', onScroll); } });
  transcript.attachUpdateFinished(scheduleScroll);
  const attachmentList = new HBox({ wrap: 'Wrap', visible: { path: 'forge>/attachments', formatter: (items: unknown[]) => items.length > 0 } }).addStyleClass('forgeChatAttachments');
  attachmentList.bindAggregation('items', { path: 'forge>/attachments', factory: (_id: string, context: Context) =>
    new Button({ text: context.getProperty('name') as string, icon: 'sap-icon://decline', tooltip: strings.removeAttachment,
      enabled: idleBinding(), press: () => run(() => session.removeAttachment(context.getProperty('id') as string)) }) });
  const attach = new Button({ icon: 'sap-icon://attachment', type: 'Transparent', tooltip: strings.attach, visible: !!options.gateway.uploadAttachment,
    enabled: idleBinding(), press: () => {
      const input = document.createElement('input'); input.type = 'file';
      input.addEventListener('change', () => { const file = input.files?.[0]; if (file) run(() => session.attach(file)); }, { once: true }); input.click();
    } });
  const approval = new VBox({ visible: '{forge>/approvalRequired}', items: [
    new MessageStrip({ text: strings.approval, type: 'Warning', showIcon: true }),
    new Button({ text: strings.openApproval, visible: !!options.onApprovalRequested, press: () => {
      const id = session.getState().conversationId; if (id) options.onApprovalRequested?.(id);
    } }),
  ] }).addStyleClass('forgeChatApproval');
  const resume = new Button({ text: { parts: [{ path: 'forge>/error' }, { path: 'forge>/approvalRequired' }],
    formatter: (error: string, approval: boolean) => error && !approval ? strings.retry : strings.resume },
    visible: '{forge>/canResume}', enabled: { path: 'forge>/busy', formatter: (busy: boolean) => !busy }, press: () => run(() => session.resume()) });
  const stop = new Button({ text: strings.stop, icon: 'sap-icon://stop', visible: '{forge>/canStop}',
    enabled: { path: 'forgeUI>/canceling', formatter: (canceling: boolean) => !canceling }, press: () => run(async () => {
      viewModel.setProperty('/canceling', true);
      try { await session.stop(); } finally { if (!destroyed) viewModel.setProperty('/canceling', false); }
    }) });
  const send = new Button({ text: strings.send, type: 'Emphasized', icon: 'sap-icon://paper-plane',
    visible: { path: 'forge>/canStop', formatter: (canStop: boolean) => !canStop },
    enabled: { parts: [{ path: 'forge>/busy' }, { path: 'forge>/canResume' }, { path: 'forgeUI>/draft' }],
      formatter: (busy: boolean, pending: boolean, draft: string) => !busy && !pending && !!draft.trim() }, press: submit });
  const activity = new Text({ text: { parts: [{ path: 'forge>/busy' }, { path: 'forge>/activity' }, { path: 'forge>/canStop' },
    { path: 'forge>/canResume' }, { path: 'forgeUI>/canceling' }, { path: 'forge>/approvalRequired' }, { path: 'forge>/status' }],
    formatter: (busy: boolean, detail: string, canStop: boolean, pending: boolean, canceling: boolean, approval: boolean, status: string) =>
      canceling || status === 'canceling' ? strings.canceling : busy ? detail || (canStop ? strings.responding : strings.loading)
        : pending ? approval ? strings.waitingApproval : strings.interrupted : '' },
    visible: { parts: [{ path: 'forge>/busy' }, { path: 'forge>/canResume' }], formatter: (busy: boolean, pending: boolean) => busy || pending } }).addStyleClass('forgeChatActivity');
  activity.addEventDelegate({ onAfterRendering: () => { const node = activity.getDomRef(); node?.setAttribute('role', 'status'); node?.setAttribute('aria-live', 'polite'); } });
  const composerBox = new VBox({ width: '100%', items: [attachmentList, composerLabel, composer,
    new Toolbar({ content: [attach, new Text({ text: strings.composerHint }).addStyleClass('forgeChatKeyboardHint'),
      new ToolbarSpacer(), resume, stop, send] }).addStyleClass('forgeChatComposerToolbar'),
  ] }).addStyleClass('forgeChatComposer');
  const footer = new VBox({ width: '100%', alignItems: 'Center', items: [
    new Button({ text: strings.latest, icon: 'sap-icon://navigation-down-arrow', type: 'Transparent',
      visible: '{forgeUI>/awayFromLatest}', press: scrollToLatest }).addStyleClass('forgeChatLatest'), approval,
    new MessageStrip({ text: { parts: [{ path: 'forge>/error' }, { path: 'forgeUI>/notice' }], formatter: (error: string, notice: string) => error || notice },
      type: 'Error', showIcon: true, visible: { parts: [{ path: 'forge>/error' }, { path: 'forgeUI>/notice' }], formatter: (error: string, notice: string) => !!(error || notice) } }),
    activity, composerBox, new Text({ text: strings.footer, textAlign: 'Center' }).addStyleClass('forgeChatFooterNote'),
  ] }).addStyleClass('forgeChatFooter');
  const content = new VBox({ height: '100%', width: '100%', layoutData: new FlexItemData({ growFactor: 1, baseSize: '0%', minWidth: '0' }), items: [
    new Toolbar({ content: [new Icon({ src: 'sap-icon://discussion', decorative: true }).addStyleClass('forgeChatHeaderIcon'),
      new VBox({ items: [new Title({ text: strings.title, level: 'H1' }), new Text({ text: strings.subtitle }).addStyleClass('forgeChatSubtitle')] }),
      new ToolbarSpacer(), new Button({ icon: 'sap-icon://discussion', type: 'Transparent', tooltip: strings.history, visible: options.showHistory !== false,
        press: () => historyDialog.open() }).addStyleClass('forgeChatHistoryButton'),
      new Button({ text: strings.newChat, icon: 'sap-icon://add', type: 'Transparent', enabled: idleBinding(), press: startNewChat })
        .addStyleClass(options.showHistory === false ? '' : 'forgeChatHeaderNewChat'),
    ] }).addStyleClass('forgeChatHeader'), scroll, footer,
  ] }).addStyleClass('forgeChatContent');
  const control = new HBox({ width: '100%', height: '100%', items: [sidebar, content] }).addStyleClass('forgeChatPanel');
  control.setModel(model, 'forge'); control.setModel(viewModel, 'forgeUI');
  historyDialog = new Dialog({ title: strings.history, contentWidth: '26rem', contentHeight: '28rem', stretchOnPhone: true,
    content: [historyPane.clone('mobile') as VBox], endButton: new Button({ text: strings.close, press: () => historyDialog.close() }) });
  mobileHistory = ((historyDialog.getContent()[0] as VBox).getItems()[2] as ScrollContainer).getContent()[0] as List;
  for (const list of [history, mobileHistory]) list.attachUpdateFinished(scheduleScroll);
  control.addDependent(historyDialog);
  control.addEventDelegate({ onkeydown: (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && options.showHistory !== false) {
      event.preventDefault();
      if (window.matchMedia('(max-width: 48rem)').matches) historyDialog.open(); else historySearch.focus();
    }
  } });
  let previous = session.getState();
  const unsubscribe = session.subscribe(state => {
    if (state.conversationId !== previous.conversationId || state.messages.length > previous.messages.length) followLatest = !pendingSearchHit;
    if (state.conversationId) searchIndex.remember(state.conversationId, state.messages);
    if (JSON.stringify(state.conversations) !== JSON.stringify(previous.conversations)) queueSearch(viewModel.getProperty('/historyQuery'));
    else if (!options.gateway.searchConversations || !viewModel.getProperty('/historyQuery'))
      updateHistory(searchIndex.peek(viewModel.getProperty('/historyQuery'), state.conversations));
    if (submittedDraft && state.messages.filter(message => message.role === 'user').length > submittedDraft.userCount) {
      // Keep the draft if creating a conversation failed. Clear only after the session records the user's message.
      if (viewModel.getProperty('/draft') === submittedDraft.text) viewModel.setProperty('/draft', '');
      submittedDraft = undefined;
    }
    updateModel(state, previous); previous = state; scheduleScroll();
  });
  function updateModel(state: ChatViewState, before: ChatViewState) {
    // Preserve message controls during streaming, so reading position and focus survive token updates.
    if (state.messages.length !== before.messages.length || state.messages.some((message, index) => message.id !== before.messages[index]?.id)) {
      model.setProperty('/messages', state.messages);
    } else state.messages.forEach((message, index) => {
      if (message.text !== before.messages[index]?.text) model.setProperty(`/messages/${index}/text`, message.text);
      if (message.status !== before.messages[index]?.status) model.setProperty(`/messages/${index}/status`, message.status);
      if (JSON.stringify(message.citations) !== JSON.stringify(before.messages[index]?.citations)) model.setProperty(`/messages/${index}/citations`, message.citations);
    });
    for (const key of Object.keys(state) as Array<keyof ChatViewState>) {
      if (key !== 'messages' && JSON.stringify(state[key]) !== JSON.stringify(before[key])) model.setProperty('/' + key, state[key]);
    }
  }
  const ready = session.initialize();
  return { control, model, session, ready, destroy: () => {
    destroyed = true; unsubscribe(); resizeObserver.disconnect();
    if (searchTimer) clearTimeout(searchTimer); searchAbort?.abort(); searchIndex.clear(); if (scrollFrame !== undefined) cancelAnimationFrame(scrollFrame);
    scroll.getDomRef()?.removeEventListener('scroll', onScroll);
    if (!options.session) session.dispose(); control.destroy(); model.destroy(); viewModel.destroy();
  } };
}
export function createChatPage(options: ChatPanelOptions): ChatPanelHandle & { page: Page } {
  const handle = createChatPanel(options);
  const page = new Page({ showHeader: false, enableScrolling: false, content: [handle.control] });
  return { ...handle, page, destroy: () => { handle.destroy(); page.destroy(); } };
}
