import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generate } from '../src/llm.js';
import { generatedSchemas, type ContentTool } from '../src/core.js';

// Five calls total: headlines for three products, plus a script and outline.
// This is a regression screen, not a semantic proof of grounding. Inspect printed
// drafts for implied claims too. Numbers/known unsupported claims fail the run.
const samples = [
  { product: 'bamboo cutting board', facts: 'Bamboo cutting board. Material: bamboo. Dimensions: 30 × 20 cm. Hand wash only.', audience: 'everyday shoppers' },
  { product: 'blue ceramic tea mug', facts: 'Material: ceramic. Blue glaze. Capacity: 300 ml. Hand wash only.', audience: 'tea drinkers' },
  { product: 'cotton tote bag', facts: 'Material: cotton. Black. Dimensions: 38 × 42 cm. Open top. No pockets.', audience: 'everyday shoppers' },
];
const risky = /\b(?:antibacterial|antimicrobial|guaranteed|certified|cures?|prevents?|eco[- ]friendly|sustainable|organic|waterproof|dishwasher[- ]safe|leakproof|scratch[- ]resistant|knife[- ]friendly|durable|long[- ]lasting|non[- ]?toxic|soft|smooth|lightweight|ergonomic|free shipping|bestselling|best[- ]selling|grain|canvas|stable|easy cleanup|clean cuts|water beads|air dry|air dries|one trip|fast[- ]growing|density)\b/gi;
function copyStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(copyStrings);
  if (!value || typeof value !== 'object') return [];
  // needsInfo is an explicit question, never a product claim. Scene timestamps
  // are structure and must not count as newly invented product measurements.
  return Object.entries(value).filter(([k]) => !['needsInfo', 'start', 'end'].includes(k)).flatMap(([, v]) => copyStrings(v));
}
export function checkDraft(tool: ContentTool, data: unknown, input: typeof samples[number]) {
  const parsed = generatedSchemas[tool].parse(data);
  const copy = copyStrings(parsed).join('\n');
  const allowedNumbers = new Set((input.product + ' ' + input.facts).match(/\d+(?:\.\d+)?/g) || []);
  for (const n of copy.match(/\d+(?:\.\d+)?/g) || []) assert.ok(allowedNumbers.has(n), `Unsupported number: ${n}`);
  for (const claim of copy.match(risky) || []) assert.ok((input.product + ' ' + input.facts).toLowerCase().includes(claim.toLowerCase()), `Unsupported claim: ${claim}`);
  const otherFacts = samples.filter(s => s !== input).flatMap(s => s.product.split(' ')).filter(w => !['cutting', 'tea'].includes(w));
  for (const word of otherFacts) if (!(input.product + input.facts).toLowerCase().includes(word))
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(copy), `Cross-product fact leaked: ${word}`);
  if (tool === 'ad_headlines') {
    const headlines = (parsed as { headlines: string[] }).headlines;
    const openings = headlines.map(h => h.toLowerCase().split(/\W+/).slice(0, 2).join(' '));
    assert.equal(new Set(openings).size, 3, 'Repeated headline openings');
    const tokens = headlines.map(h => new Set(h.toLowerCase().match(/[a-z]+/g) || []));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const overlap = [...tokens[i]].filter(t => tokens[j].has(t)).length / new Set([...tokens[i], ...tokens[j]]).size;
      assert.ok(overlap < 0.65, 'Headlines repeat the same wording');
    }
  }
  return { schemaAndLength: 'pass', suppliedNumbers: 'pass', knownRiskyClaims: 'pass', crossProductLeakage: 'pass', ...(tool === 'ad_headlines' ? { lexicalVariety: 'pass' } : {}) };
}

async function main() {
  const endpoint = process.env.EVAL_URL;
  assert.ok(endpoint || process.env.LLM_API_KEY, 'Set EVAL_URL to a live MCP endpoint or provide LLM_API_KEY. Demo output is not a live eval.');
  const client = endpoint ? new Client({ name: 'seller-writing-eval', version: '1.0.0' }) : undefined;
  if (client) await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), {
    requestInit: process.env.MCP_AUTH_TOKEN ? { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } } : {},
  }));
  try {
    for (const [i, input] of samples.entries()) {
      for (const tool of (i === 0 ? ['ad_headlines', 'shorts_script', 'detail_page_outline'] : ['ad_headlines']) as ContentTool[]) {
        const start = performance.now();
        const result = client ? await client.callTool({ name: tool, arguments: input }) : undefined;
        if (result) assert.notEqual(result.isError, true);
        const output = (result?.structuredContent ?? await generate(tool, input)) as { mode: string; data: unknown; notice?: string; model?: string };
        assert.equal(output.mode, 'live', output.notice || 'Expected live output');
        assert.equal(output.model, process.env.LLM_MODEL || 'nvidia/Nemotron-3_5-Lightning', 'Unexpected configured model');
        const checks = checkDraft(tool, output.data, input);
        console.log(JSON.stringify({ product: input.product, tool, mode: output.mode, model: output.model, elapsedMs: Math.round(performance.now() - start), checks, data: output.data }, null, 2));
      }
    }
    console.log('PASS: 5 live calls, 3 products. Automated grounding checks are limited; review drafts for implied claims.');
  } finally { await client?.close(); }
}
if (process.argv[1]?.endsWith('/eval.ts')) await main();
