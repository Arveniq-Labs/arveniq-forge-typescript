# Arveniq Forge SDK

TypeScript SDK for server-side applications that integrate with Arveniq Forge O/S.

It provides two deliberately separate capabilities:

- `ForgeDeveloperClient` calls the scoped Forge Developer API for agent/workflow discovery, asynchronous runs, traces, and rate-limit status.
- Manifest helpers build and validate governed tool-package definitions before they are submitted to a Forge Tool Package management API.

The SDK is server-only. It rejects browser runtimes, never accepts a caller-supplied Forge user header, and must be given a scoped Forge API key from a server-side secret store.

## Mobile integrations

The server SDK intentionally remains server-only. Mobile apps must use the separate mobile client packages in `packages/mobile-core`, `packages/react-native`, and `packages/expo`; they call a customer-owned or Forge-hosted **mobile integration gateway**, never the Forge Developer API.

The gateway issues short-lived, audience-bound access tokens and accepts an opaque context assertion minted by a trusted backend after it verifies the signed-in user's authorization. Apps must not contain Forge Developer API keys or send authoritative account, tenant, portfolio, or similar resource IDs as agent context. The versioned gateway contract and replay fixtures live in [`arveniq-forge-protocol`](https://github.com/Arveniq-Labs/arveniq-forge-protocol).

## Install

```bash
npm install @arveniq/forge-sdk
```

## Call Forge from an application backend

Create the client once in server-side application code. Use a least-privilege, workspace-scoped key with the `agents:read`, `runs:trigger`, `runs:read`, and—only if required—`traces:read` scopes.

```ts
import { ForgeDeveloperClient } from '@arveniq/forge-sdk';

const forge = new ForgeDeveloperClient({
  baseUrl: process.env.FORGE_API_URL ?? 'https://forge.example.com/v1',
  apiKey: process.env.FORGE_API_KEY!,
  userAgent: 'capitalfi-api/1.0',
});

const run = await forge.triggerAgentRun(
  process.env.FORGE_CAPITALFI_AGENT_ID!,
  {
    idempotencyKey: `capitalfi-turn:${turnId}`,
    input: { prompt: userMessage },
  },
  { requestId },
);

const completedRun = await forge.waitForRun(run.id, {
  requestId,
  timeoutMs: 60_000,
});
if (completedRun.status === 'completed' || completedRun.status === 'succeeded') {
  console.log(completedRun.finalAnswer); // The sanitized answer, or null if unavailable.
}
```

The live Developer API is rooted at:

```text
https://<forge-host>/v1/developer/v1
```

The SDK expects `baseUrl` to include `/v1`; it appends the Developer API path itself. The existing run API remains asynchronous: trigger a run, then poll it with `waitForRun` or `getRun`. `waitForRun` returns when a run succeeds, fails, is cancelled/times out, or pauses for approval; callers must handle an `approval_required` or `waiting_approval` status explicitly. For embedded chat, use conversation streaming below to receive answers without status polling.

`getRun` and `waitForRun` expose `finalAnswer`; `getRunTrace` exposes
`run.finalAnswer`. This nullable string is returned only after successful
completion, for both canonical and legacy run IDs. Private drafts and raw tool
output are never included. Run lists and trigger responses remain metadata-only.
The SDK marks this field optional because older API deployments omit it; the
Developer API polling-answer fix must be deployed to receive it. Fetching the
answer through `getRun` needs `runs:read`, not `traces:read`.

## Embedded chat with streaming

The conversation API streams answers without client polling. It requires an API
deployment with conversation streaming enabled and the developer-conversations
database migration. Use `https://forge-os.io/v1` as the public SDK base URL.

```ts
import { ForgeDeveloperClient, reduceChatEvent, type ForgeChatState } from '@arveniq/forge-sdk';

// Application backend only. Verify the signed-in user before accessing a conversation.
const forge = new ForgeDeveloperClient({
  baseUrl: 'https://forge-os.io/v1',
  apiKey: process.env.FORGE_API_KEY!,
});
// Create once and save the ID against your application's user/session.
const conversation = await forge.createConversation({ agentId: 'YOUR_AGENT_ID' });
let state: ForgeChatState = { text: '' };
for await (const event of forge.streamMessage(conversation.id, {
  clientMessageId: 'YOUR_STABLE_MESSAGE_ID',
  message: 'How can you help me?',
})) {
  state = reduceChatEvent(state, event);
  // Relay each event immediately to the authorized browser over SSE.
  console.log(event.type, state.text);
}
```

Required scopes: `agents:read` + `runs:trigger` to create a conversation,
`runs:trigger` + `runs:read` to send and stream a message, `runs:read` to get
history or resume a stream, and `runs:trigger` to cancel a turn. API keys authorize
the application workload; your backend must enforce end-user conversation ownership.

`streamMessage` returns an async iterable. It retries a lost initial response with
the same `clientMessageId`; after `turn.accepted`, it reconnects to the saved turn
with its last processed event ID. It never re-submits a message after learning the
turn ID. Reconnection defaults to five attempts with exponential backoff. Options
include `signal`, `maxReconnects`, and `reconnectDelayMs`.

To resume after a process restart, save the turn ID, last event ID, and assembled
text together, then use `streamConversationTurn(conversationId, turnId,
{ afterEventId })`. `reduceChatEvent` handles deltas, replacement, and duplicate
sequences. Fetch `getConversation(conversationId)` for the latest 100 turns and
their canonical final answers if a replay cursor is no longer available.

Events: `turn.accepted`, `activity.updated`, `response.started`, `response.delta`,
`response.completed`, `turn.requires_action`, `turn.completed`, `turn.failed`,
and `turn.canceled`. Each event carries conversation, turn, and message identifiers;
persisted events also carry an event ID and a per-turn sequence string. Unknown
future event types should be ignored. `response.completed` settles answer text;
`turn.completed` confirms successful execution.

Only one turn may be active in a conversation. `turn.requires_action` ends the
current stream while the run awaits approval in Forge. Resume the stream after
approval; another user message remains blocked until that turn settles or is
canceled. Closing a stream or aborting its signal does not cancel execution.
Use `cancelConversationTurn(conversationId, turnId)` for an explicit Stop request;
it cannot undo external actions that already completed.

Tool-enabled conversations may add one model call for final-answer synthesis with
tools disabled. Whole-answer citation validation and structured-output policies
retain buffering; progress events remain available. History sent to the model is
bounded to the most recent 20 completed turns within 48,000 characters.

See [the backend and React integration example](examples/embedded-chat.md).

## Application identity and resource context

Forge Developer API keys authenticate the calling workload. They do not authenticate an end user or authorize a portfolio, account, tenant, or other application-owned resource.

Your application backend must:

1. Verify its own SSO session.
2. Resolve the signed-in user and authorized resource server-side.
3. Call Forge from that backend using this SDK.
4. Supply only trusted context through a dedicated Forge integration endpoint or a server-bound tool adapter.

Never put browser-supplied user, account, wallet, or portfolio IDs into a generic agent-run input. Never instantiate this SDK in browser, mobile, or public client code.

For a CapitalFi-style integration, the browser calls CapitalFi’s API with the message only. CapitalFi derives the signed-in user and portfolio, then uses a short-lived, signed context assertion at the dedicated Forge integration boundary. That context endpoint is separate from the generic Developer API run endpoint and must be deployed before a production financial-assistant integration goes live.

## Build a governed tool manifest

The manifest helpers validate namespaces, handler references, required scopes, execution modes, environments, risk levels, approval requirements, audit policy, and schema shape. `createReadOnlyHandler` is useful for lookup and explanation tools because it cannot be configured to write or perform an external action, and it always preserves call/input/output audit metadata.

```ts
import {
  createManifest,
  createReadOnlyHandler,
  validateManifest,
} from '@arveniq/forge-sdk';

const manifest = createManifest({
  name: 'capitalfi-read-tools',
  namespace: 'capitalfi',
  version: '1.0.0',
  description: 'Governed CapitalFi portfolio information tools.',
  runtime: { type: 'node', entrypoint: 'src/index.ts' },
  handlers: [
    createReadOnlyHandler({
      handlerRef: 'tool://capitalfi/get_portfolio_summary',
      slug: 'get_portfolio_summary',
      name: 'Get Portfolio Summary',
      description: 'Returns an authorized user’s portfolio summary.',
      requiredScopes: ['capitalfi.portfolio.read'],
      inputSchema: {
        type: 'object',
        properties: { question: { type: 'string' } },
      },
      outputSchema: {
        type: 'object',
        properties: {
          asOf: { type: 'string' },
          totalValue: { type: 'number' },
        },
      },
    }),
  ],
});

const validation = validateManifest(manifest);
if (!validation.valid) throw new Error(JSON.stringify(validation.errors, null, 2));
```

The manifest describes a package; the SDK does not execute package code. Forge must validate, approve, deploy, bind, and route the handler through its Tool Registry and Tool Router.

## Tool Package API client

`ForgeToolPackagesClient` remains available for deployments that expose the Tool Package management API. It is distinct from the current public Developer API and should not be used as the integration runtime client.

```ts
import { ForgeToolPackagesClient } from '@arveniq/forge-sdk';

const packages = new ForgeToolPackagesClient({
  baseUrl: process.env.FORGE_API_URL!,
  apiKey: process.env.FORGE_API_KEY!,
});

const version = await packages.createVersion(packageId, {
  version: '1.0.0',
  commitSha,
  environment: 'DEVELOPMENT',
  manifest,
});
```

## CLI

```bash
export FORGE_API_URL=http://localhost:4000/v1
export FORGE_API_KEY=forge_sk_...

forge-tool validate --manifest tool-package.json
forge-tool create-version --package-id pkg_123 --manifest tool-package.json --version 1.0.0 --commit-sha abc123
forge-tool validate-version --version-id version_123
forge-tool deploy-version --version-id version_123 --environment STAGING --reason "Release candidate"
```

The CLI uses Tool Package management endpoints. Keep `FORGE_API_KEY` in a secret manager or local shell environment; do not commit it or expose it to a browser.

## Security model

- The SDK accepts a scoped API key and sends it only as `Authorization: Bearer …`.
- A generated or caller-provided `x-request-id` is sent with each request for auditing and tracing.
- It never sends `x-forge-user-id`, `x-forge-control-plane-token`, or runtime service credentials.
- It permits only absolute HTTPS base URLs without embedded credentials, query strings, or fragments; HTTP is restricted to loopback development hosts.
- It does not execute tool-package source code or bypass Forge Tool Router policy.

## License

Apache-2.0
