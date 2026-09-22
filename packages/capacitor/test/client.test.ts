import assert from 'node:assert/strict';
import test from 'node:test';
import { CapacitorTokenStore, createCapacitorForgeClient } from '../src/index.js';

test('uses Capacitor preferences only for the short-lived gateway token', async () => {
  const values = new Map<string, string>();
  const preferences = {
    get: async ({ key }: { key: string }) => ({ value: values.get(key) ?? null }),
    set: async ({ key, value }: { key: string; value: string }) => { values.set(key, value); },
    remove: async ({ key }: { key: string }) => { values.delete(key); },
  };
  const store = new CapacitorTokenStore(preferences);
  await store.saveAccessToken('short-lived-token');
  const client = createCapacitorForgeClient({
    baseUrl: 'https://gateway.example/v1',
    preferences,
    fetcher: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer short-lived-token');
      return Response.json({ id: 'conversation-1', createdAt: '2026-09-22T00:00:00Z' }, { status: 201 });
    },
  });
  await client.createConversation({ contextAssertion: { value: 'opaque-trusted-context-assertion-value-001' } });
});
