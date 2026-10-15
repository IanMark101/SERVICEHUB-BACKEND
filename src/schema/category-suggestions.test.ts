import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryMatchesFromText } from '../lib/category-suggestions';
import { env } from '../config/env';

const categories = [
  { id: 'computer', name: 'Computer & Laptop Repair' },
  { id: 'plumbing', name: 'Plumbing' },
  { id: 'wiring', name: 'Electrical Wiring & Repairs' },
  { id: 'internet', name: 'Internet & Wi-Fi Setup' },
  { id: 'other', name: 'Other Services' },
];

test('catalog fallback recognizes concrete work without guessing from generic repair words', () => {
  for (const title of ['COMPUTER REPAIR', 'LAPTOP FAN NOT TURNING', 'PC repair', 'My printer is broken']) {
    assert.equal(categoryMatchesFromText({ title, description: '' }, categories)[0], 'computer', title);
  }
  assert.deepEqual(categoryMatchesFromText({ title: 'Need someone to repair it', description: '' }, categories), []);
  assert.deepEqual(categoryMatchesFromText({ title: 'Need help', description: 'The computer stopped working.' }, categories), ['computer']);
  assert(!categoryMatchesFromText({ title: 'Set up my router', description: '' }, categories).includes('computer'));
  assert.deepEqual(categoryMatchesFromText({ title: 'Clock repair', description: '' }, [{ id: 'custom', name: 'Clock Repair' }]), ['custom']);
});

test('category service degrades safely and keeps model output bounded to the active catalog', async t => {
  const singleton = globalThis as unknown as { prisma?: unknown };
  const previousPrisma = singleton.prisma, previousKey = env.GEMINI_API_KEY, previousModel = env.GEMINI_SUMMARY_MODEL;
  const nativeFetch = globalThis.fetch;
  let live = [...categories];
  singleton.prisma = { category: { findMany: async ({ where }: { where: { id?: { in: string[] }; isActive: boolean } }) => {
    assert.equal(where.isActive, true);
    return live.filter(category => !where.id || where.id.in.includes(category.id));
  } } };
  t.after(() => {
    globalThis.fetch = nativeFetch;
    env.GEMINI_API_KEY = previousKey; env.GEMINI_SUMMARY_MODEL = previousModel;
    if (previousPrisma === undefined) delete singleton.prisma; else singleton.prisma = previousPrisma;
  });
  t.mock.method(console, 'warn', () => {});
  const { suggestCategories } = await import('../services/ai-marketplace.service');
  const input = { title: 'COMPUTER REPAIR', description: '' };
  const assertFallback = (result: Awaited<ReturnType<typeof suggestCategories>>) => {
    assert.equal(result.source, 'catalog');
    assert.deepEqual(result.suggestions, [categories[0]]);
    assert.equal(result.reason, undefined);
  };
  await t.test('missing configuration still returns useful catalog suggestions without an upstream call', async () => {
    env.GEMINI_API_KEY = '';
    globalThis.fetch = t.mock.fn(async () => { throw new Error('Unexpected upstream call'); });
    assertFallback(await suggestCategories(input, 'no-key'));
  });
  env.GEMINI_API_KEY = 'synthetic-test-key'; env.GEMINI_SUMMARY_MODEL = 'gemini-2.5-flash';
  await t.test('rate limits, server errors and timeouts preserve valid suggestions', async () => {
    for (const status of [429, 503]) {
      globalThis.fetch = async () => new Response('{}', { status });
      assertFallback(await suggestCategories(input, `status-${status}`));
    }
    globalThis.fetch = async () => { throw new DOMException('Fixture timeout', 'TimeoutError'); };
    assertFallback(await suggestCategories(input, 'timeout'));
  });
  await t.test('foreign IDs, duplicate IDs, malformed JSON and empty output use the catalog', async () => {
    for (const [index, output] of ['{"ids":["foreign-id"]}', '{"ids":["computer","computer"]}', 'not json', '{"ids":[]}'].entries()) {
      globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: output }] } }] }));
      assertFallback(await suggestCategories(input, `invalid-${index}`));
    }
  });
  await t.test('structured low-latency AI requests coalesce, cache and preserve supplied IDs', async () => {
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
      assert.equal(body.generationConfig.maxOutputTokens, 512);
      assert.equal(body.generationConfig.responseSchema.properties.ids.maxItems, 3);
      assert.deepEqual(body.generationConfig.responseSchema.properties.ids.items.enum, categories.map(category => category.id));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ids":["computer"]}' }] } }] }));
    };
    const pair = await Promise.all([suggestCategories(input, 'success'), suggestCategories(input, 'success')]);
    assert(pair.every(result => result.source === 'gemini'));
    assert.equal(calls, 1);
    await suggestCategories(input, 'success');
    assert.equal(calls, 1);
  });
  await t.test('an inactive category is excluded even if it changes during the AI request', async () => {
    globalThis.fetch = async () => {
      live = categories.filter(category => category.id !== 'computer');
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ids":["computer"]}' }] } }] }));
    };
    assert.deepEqual((await suggestCategories(input, 'deactivated')).suggestions, []);
    live = [...categories];
  });
  await t.test('Other Services does not compete with a specific model-selected category', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ids":["computer","other"]}' }] } }] }));
    assert.deepEqual((await suggestCategories(input, 'specific')).suggestions, [categories[0]]);
  });
  await t.test('other configured models do not receive Flash-specific thinking settings', async () => {
    env.GEMINI_SUMMARY_MODEL = 'another-configured-model';
    globalThis.fetch = async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).generationConfig.thinkingConfig, undefined);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ids":["computer"]}' }] } }] }));
    };
    assert.equal((await suggestCategories(input, 'other-model')).source, 'gemini');
  });
  await t.test('an empty catalog or vague request yields an honest empty state', async () => {
    env.GEMINI_API_KEY = '';
    assert.deepEqual((await suggestCategories({ title: 'Need help with it', description: '' }, 'vague')).suggestions, []);
    live = [];
    const result = await suggestCategories(input, 'empty');
    assert.deepEqual(result.suggestions, []);
    assert.match(result.reason!, /Service categories are unavailable/);
  });
});
