# Forge for SAPUI5

`@arveniq/forge-sapui5` provides an Ask Forge AI chat interface built with
native SAPUI5 controls, a browser gateway client, a framework-independent session
controller, and a server-only Forge relay. Version 0.1.0 supports a full-page Fiori
application and an embedded panel in individual SAPUI5 applications.

The browser calls an authenticated **application gateway**. The existing
`@arveniq/forge-sdk` and its Developer API credentials run behind that gateway.
Conversation ownership includes both the signed-in user and tenant.

## Features and boundaries

- Search titles and message text with accent/case-insensitive words or quoted phrases, ranked matches, highlighted snippets, and navigation to the matching message.
- Friendly history dates, new chats, editable prompt suggestions, and Ctrl/Command+K to focus chat search.
- A growing composer with empty-send protection, draft preservation when a conversation cannot open, Enter to send / Shift+Enter for a new line.
- Readable message bubbles, copy response, and scroll position preservation with a jump-to-latest action.
- Streaming Markdown answers: headings, emphasis, lists, blockquotes, code, strikethrough, safe web links, and tables.
- Tables retain comfortable column widths and padding, with keyboard-accessible horizontal scrolling inside the response.
- Data-only bar, line, pie and doughnut charts, legends, hover values and an expandable exact-value data table.
- Execution progress, Stop, and retry/resume.
- Stable message IDs, replay cursors, duplicate-event protection, bounded reconnect attempts.
- Approval-pending display, a host callback to open an authorized approval workflow, and resume afterward.
- Optional file upload hook and validated HTTP(S) citations supplied by a host gateway.
- JSONModel binding, custom labels, responsive layout, and Horizon light/dark theme CSS.
- A TypeScript sample component with the `AskPingLead-chat` Launchpad intent, plus BTP routing configuration.

The default relay uses the existing **text-only** Forge Developer conversation API.
It does not submit attachments or grant approvals. Enable `uploadAttachment` only
with a host gateway that authorizes, processes, and attaches files to its messages.
Citation controls render a gateway's optional `data.citations` array of
`{ title, url }`; the default Developer API supplies answer text rather than a
structured citation array. The renderer uses Markdown-it with raw HTML disabled and HTTP(S)/mailto links only.
Remote images display their alt text without fetching the image. Chart blocks accept
validated numeric data; raw SVG, scripts, callbacks and chart configuration code
are never executed.

SAP data permissions and principal propagation are enforced by host/server tool
adapters. A Launchpad role or conversation ownership check alone does not authorize
business records. Voice and rich artifact previews are outside this version.

## Run the local preview

From the TypeScript SDK repository:

```sh
npm ci
npm run build:sap
npm ci --prefix packages/sapui5/examples/fiori
```

Start these in separate terminals:

```sh
npm run demo:sap
npm run start:sap
```

Open `http://localhost:8090/index.html`. The preview runs with OpenUI5 1.136.15
and controls compatible with SAPUI5. The demo gateway binds to loopback on port
8091, uses a fixed development identity and in-memory records, and generates
**synthetic answers**. It is not a production authentication implementation.

## Embed the UI

Add the npm package as a dependency and `arveniq.forge.sapui5` to your manifest's
`sap.ui5.dependencies.libs`. UI5 consumers import its native module namespace:

```ts
import { ForgeChatGatewayClient } from 'arveniq/forge/sapui5/index';
import { createChatPanel } from 'arveniq/forge/sapui5/ui5';

const gateway = new ForgeChatGatewayClient({
  baseUrl: '/api/forge-chat',
  csrfTokenProvider: getAuthenticatedHostCsrfToken,
});
const chat = createChatPanel({
  gateway,
  showHistory: false,
  title: 'Ask our assistant',
  suggestions: ['Summarize my open orders'],
  strings: { send: 'Send message' },
  onApprovalRequested: conversationId => openAuthorizedApprovalWorkflow(conversationId),
});
hostContainer.addItem(chat.control);
await chat.ready;
// In the host controller/component exit hook:
chat.destroy();
```

Use `createChatPage` for a full-page layout and put its `.page` in `sap.m.App` or
another navigation container. Containers embedding `.control` must provide a
defined height. The sample component demonstrates this lifecycle.

Framework-independent consumers can import `ForgeChatGatewayClient` and
`ForgeChatSession` from `@arveniq/forge-sapui5`. The `./ui5` entry point requires
the UI5 module loader. The `./server` entry point requires Node.js; never import it
into browser code. Native ESM output and declarations are in `dist/esm`; native
UI5 resources, preload bundles, and themes are in `dist/ui5/resources`.

Configure `ui5-tooling-transpile` and `ui5-tooling-modules` in the consuming app as
shown in `examples/fiori/ui5.yaml`. When serving the package's TypeScript sources,
set `transpileDependencies: true`. Build with:

```sh
ui5 build --include-dependency arveniq.forge.sapui5
```

Include the resulting custom library resources in the deployed app. Match your
UI5 type definitions to the supported host runtime; the minimum declared runtime
is 1.120. The local preview verifies 1.136.15, not every historical UI5 version.

## Markdown tables and charts

Send standard Markdown text through the existing response stream. Tables use pipe
syntax and alignment separators (`:---`, `---:`); each cell keeps a minimum width
of 10rem with generous padding. Wide tables and chart plots keep their scrollbars
hidden while remaining horizontally scrollable. Arrow keys scroll a focused table, and table position survives streamed
text updates.

Charts are an SDK extension to Markdown. Ask your agent to emit a fenced `chart`
JSON block using this data contract:

```chart
{
  "type": "bar",
  "title": "Monthly revenue (USD)",
  "labels": ["July", "August", "September"],
  "series": [
    { "name": "Actual", "values": [90000, 110000, 125000] },
    { "name": "Target", "values": [100000, 115000, 120000] }
  ]
}
```

Supported types are `bar`, `line`, `pie`, and `doughnut`. Bar and line charts support
up to six series and signed values. All charts accept 1–50 labels, matching value
array lengths, and finite numbers with absolute values up to 1e12. Pie/doughnut
charts require one nonnegative series with a positive total. Titles/labels are
escaped, unsupported or invalid chart data shows a readable code fallback, and
an incomplete streamed chart stays in a pending state until its fence closes.
Charts render as SVG without a remote service. Small screens can scroll the chart
plot to retain legible axes. `View chart data` exposes the exact original values.

## Search behavior

Search is debounced, supports multiple words and quoted phrases, ignores case and
accents, and ranks title matches before message matches. Results show a context
snippet and open the matching message. Clear the search field to restore history.

A host gateway can implement the optional `ChatGateway.searchConversations(query,
signal)` method for server-side full-text search. Return `ConversationSearchResult`
records, with an optional zero-based `messageIndex` into the snapshot's interleaved
user/assistant messages. Apply the same user/tenant authorization as history reads.

Without that hook, the panel searches listed conversations through their existing,
authorized `getConversation` calls with at most three concurrent requests. It keeps
content only in the panel's memory, refreshes histories after a minute, updates the active chat's
index as messages arrive, aborts stale queries and reports incomplete searches.
Destroying the panel clears the cache. Prefer the host search hook for large histories.
Search does not require a new Forge Developer API endpoint.

## Connect an authenticated backend

The server package deliberately requires host authentication and mutation
verification callbacks, plus a conversation store. Both callbacks run before
any Forge request. Use a durable, tenant-aware store in production.

```ts
import { ForgeDeveloperClient } from '@arveniq/forge-sdk';
import { createChatGateway } from '@arveniq/forge-sapui5/server';

const gateway = createChatGateway({
  forge: new ForgeDeveloperClient({
    baseUrl: process.env.FORGE_API_URL!, // Include /v1.
    apiKey: process.env.FORGE_API_KEY!,
  }),
  agentId: process.env.FORGE_AGENT_ID!, // Server configuration, not browser input.
  conversations: durableConversationStore,
  authenticate: verifySapSessionAndChatEntitlement,
  verifyMutation: verifyHostCsrfAndOrigin,
  // Optional when your host issues CSRF tokens instead of the SAP app router:
  getCsrfToken: issueHostCsrfToken,
});
// In your existing Node/CAP HTTP server, before any body-consuming middleware:
app.use(async (request, response, next) => {
  if (!(await gateway(request, response))) next();
});
```

The callbacks and store in this example are supplied by the host application.
Verify signed IAS/XSUAA/session credentials and the Chat entitlement. Resolve
user and tenant from the verified identity; browser headers and IDs have no
authority. If the app router performs CSRF verification, the backend must be
reachable only through that trusted router or independently verify the token.

The relay reads the incoming request stream, so mount it **before** Express/CAP
JSON body parsers. It limits JSON requests to 64 KiB, fixes the agent server-side,
checks ownership on history/send/resume/cancel, sanitizes errors, relays SSE with
backpressure, and emits heartbeats. Disconnecting a stream does not cancel a run.
Stop calls the separate cancellation endpoint; completed external effects cannot
be undone. Run the relay behind a TLS application gateway that allows SSE.

Required Forge workload scopes: `agents:read`, `runs:trigger`, and `runs:read`.
Use a workspace-scoped key and an API deployment with Developer conversations
enabled. SAP business context must be resolved and authorized server-side through
a dedicated integration or tool adapter; it is not passed as arbitrary prompt IDs.

## Gateway contract

All routes are relative to the same-origin base URL. Mutations use the host-issued
`X-CSRF-Token` and the application's session. No Forge API key is accepted.

| Method / route | Result |
| --- | --- |
| GET `/csrf` | 204; host/app-router `X-CSRF-Token` response header |
| GET `/conversations` | `{ items: [{ id, title, createdAt }] }` for this user/tenant |
| POST `/conversations` with `{}` | New conversation summary using a configured agent |
| GET `/conversations/:id` | Conversation snapshot and canonical turns |
| POST `/conversations/:id/messages` | SSE; `{ clientMessageId, message }` |
| GET `/conversations/:id/turns/:turnId/events` | SSE replay; optional `Last-Event-ID` header |
| POST `/conversations/:id/turns/:turnId/cancel` with `{}` | 204 after cancellation request |

SSE uses the existing Forge v1 event envelope. Unknown additive events are ignored
for display. A new message is blocked while a turn awaits approval or recovery;
resume or cancel it before switching conversations. Reloading a pending chat
resumes from zero to rebuild its response without duplicating historical text.

For uploads, implement `ChatGateway.uploadAttachment(conversationId, file)` in a
host adapter and extend its message gateway to accept the returned attachment IDs.
The default relay rejects nonempty `attachmentIds` with 501. Do not enable the
upload UI against a text-only relay.

## Fiori Launchpad deployment

See [the deployment guide](examples/fiori/DEPLOYMENT.md). The sample contains a
component manifest, semantic object/action, XSUAA role template, app-router routes,
and an HTML5 repository MTA template. SAP tenant credentials, a destination,
durable conversation storage, and a validated SSO implementation are supplied by
the deployment environment. No live SAP tenant deployment is performed by the SDK.

## Verification

```sh
npm run test:sap
npm run typecheck:sap
npm run build:sap
npm run typecheck --prefix packages/sapui5/examples/fiori
npm run build --prefix packages/sapui5/examples/fiori
```

The tests cover gateway authorization/CSRF, stable retries and replay, approval
pauses, cancellation, optional attachment hooks, and output escaping. The sample
also needs a browser check of message streaming, Stop, history, and responsive
layout. Published packaging should be checked with `npm pack --dry-run`.

The current UI5 development tooling has transitive npm audit advisories (including
the latest `braces` release). Review those before enabling shared development
servers or a release pipeline; do not use the local demo as a public service.
The browser library does not bundle server credentials or Node relay modules.
