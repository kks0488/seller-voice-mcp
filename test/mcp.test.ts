import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { mcpHandler } from '../src/http.js';

async function fixture(env = {}) {
  const app = express(); app.use(express.json({ limit: '32kb' })); app.all('/mcp', mcpHandler(env));
  const listener = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => listener.once('listening', resolve));
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  return { url, close: () => new Promise<void>((resolve, reject) => { listener.close(error => error ? reject(error) : resolve()); listener.closeAllConnections(); }) };
}
async function client(url: URL, token?: string) {
  const c = new Client({ name: 'integration-test', version: '1.0.0' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {} })); return c;
}
test('SDK client lists and calls all five tools over stateless HTTP', async () => {
  assert.equal(LATEST_PROTOCOL_VERSION, '2025-11-25');
  const f = await fixture(); let c: Client | undefined;
  try {
    c = await client(f.url);
    assert.deepEqual((await c.listTools()).tools.map(t => t.name).sort(), ['ad_headlines', 'detail_page_outline', 'listing_audit', 'margin_check', 'shorts_script']);
    const cases = [
      { name: 'margin_check', arguments: { price: 29000, cost: 11000 } },
      { name: 'listing_audit', arguments: { listing: 'Guaranteed antibacterial board' } },
      ...['ad_headlines', 'shorts_script', 'detail_page_outline'].map(name => ({ name, arguments: { product: 'bamboo board', facts: 'Bamboo; hand wash only' } })),
    ];
    for (const call of cases) {
      const result = await c.callTool(call); assert.notEqual(result.isError, true);
      const output = result.structuredContent as { speech: string; data: Record<string, unknown>; mode: string };
      assert.ok(output.speech); assert.ok(output.data);
      assert.ok(output.speech.split(/[.!?](?:\s|$)/).filter(Boolean).length <= 2);
      assert.deepEqual(JSON.parse((result.content as { text: string }[])[0].text), output);
      if (call.name === 'margin_check') { assert.equal(output.data.unitProfit, 18000); assert.equal(output.mode, 'deterministic'); }
      if (call.name === 'ad_headlines') assert.equal(output.mode, 'demo');
    }
    const invalid = await c.callTool({ name: 'margin_check', arguments: { price: -1, cost: 1 } }); assert.equal(invalid.isError, true);
    assert.equal((await c.callTool({ name: 'unknown', arguments: {} })).isError, true);
    const second = await client(f.url); try { assert.equal((await second.listTools()).tools.length, 5); } finally { await second.close(); }
  } finally { await c?.close(); await f.close(); }
});
test('initialization negotiates exact protocol; notifications return 202 and no session', async () => {
  const f = await fixture();
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const response = await fetch(f.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw-test', version: '1' } } }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('mcp-session-id'), null);
    assert.equal((await response.json()).result.protocolVersion, '2025-11-25');
    const notification = await fetch(f.url, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': '2025-11-25' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    assert.equal(notification.status, 202);
    assert.equal((await fetch(f.url)).status, 405);
    assert.equal((await fetch(f.url, { method: 'POST', headers: { ...headers, 'MCP-Protocol-Version': 'unsupported' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).status, 400);
  } finally { await f.close(); }
});
test('auth and Origin protect the real endpoint; authorized client succeeds', async () => {
  const f = await fixture({ MCP_AUTH_TOKEN: 'test-only-placeholder' });
  try {
    assert.equal((await fetch(f.url, { method: 'POST' })).status, 401);
    assert.equal((await fetch(f.url, { method: 'POST', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(f.url, { method: 'POST', headers: { Origin: 'https://untrusted.example', Authorization: 'Bearer test-only-placeholder' } })).status, 403);
    assert.equal((await fetch(f.url, { method: 'POST', headers: { Host: 'untrusted.example', Origin: 'https://untrusted.example', Authorization: 'Bearer test-only-placeholder' } })).status, 403);
    assert.equal((await fetch(f.url, { headers: { Origin: f.url.origin, Authorization: 'Bearer test-only-placeholder' } })).status, 405);
    const c = await client(f.url, 'test-only-placeholder'); try { assert.equal((await c.listTools()).tools.length, 5); } finally { await c.close(); }
  } finally { await f.close(); }
});
test('live provider failure is an explicit tool error, never a demo success', async () => {
  const f = await fixture({ LLM_API_KEY: 'test-only-placeholder', LLM_BASE_URL: 'http://invalid.example' });
  try {
    const c = await client(f.url); try {
      const result = await c.callTool({ name: 'ad_headlines', arguments: { product: 'board', facts: 'bamboo' } });
      assert.equal(result.isError, true); assert.equal((result.structuredContent as { mode: string }).mode, 'live-error');
      assert.ok(!JSON.stringify(result).includes('test-only-placeholder'));
    } finally { await c.close(); }
  } finally { await f.close(); }
});
