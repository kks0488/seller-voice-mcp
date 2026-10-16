import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { auditInput, auditListing, computeMargin, contentInput, marginInput } from './core.js';
import { generate, type Env } from './llm.js';

export function createServer(env: Env = process.env) {
  const server = new McpServer({ name: 'seller-voice', version: '1.0.0' }, {
    instructions: 'Seller Voice helps hands-busy online sellers. Read the short speech aloud; show structured data on screen. Ask for missing inputs. Money values must share a currency. Generated copy is a draft. Demo means deterministic templates, not a live LLM.',
  });
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const wrap = (speech: string, data: unknown, mode: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ speech, data, mode }) }], structuredContent: { speech, data, mode } });
  server.registerTool('margin_check', {
    title: 'Check your margin', description: 'Calculate unit profit, margin percentage and break-even ROAS from price and cost. Optional platform fee percentage, shipping per unit and ad cost per unit default to zero. Same currency throughout; excludes taxes, overhead and returns.',
    inputSchema: marginInput.shape, annotations,
  }, async input => {
    const data = computeMargin(input);
    const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency, maximumFractionDigits: data.currency === 'KRW' ? 0 : 2 }).format(data.unitProfit);
    return wrap(`Your unit profit is ${amount}, with a ${data.marginPct.toFixed(1)} percent margin. ${data.breakEvenRoas === null ? 'You cannot break even on ads at these costs.' : `Your break-even return on ad spend is ${data.breakEvenRoas.toFixed(2)} times.`}`, data, 'deterministic');
  });
  server.registerTool('listing_audit', {
    title: 'Review a listing', description: 'Flag risky English or Korean claim patterns and missing material, dimensions, shipping or returns facts. Limited screening, not a compliance or legal approval.',
    inputSchema: auditInput.shape, annotations,
  }, async input => {
    const data = auditListing(input);
    return wrap(`I found ${data.findings.length} claim flags and ${data.missingFacts.length} missing fact fields. ${data.findings.length ? 'Review the highlighted wording before publishing.' : 'Review the remaining facts before publishing.'}`, data, 'deterministic');
  });
  for (const [name, title, description, speech] of [
    ['ad_headlines', 'Draft three ad headlines', 'Draft exactly three headlines using only supplied product facts.', 'I drafted three headlines for your product. Review them before publishing.'],
    ['shorts_script', 'Draft a 30-second short', 'Draft a 30-second product video script with contiguous timed scenes, voiceover and a call to action.', 'Your thirty-second script is ready. The screen shows each scene and its voiceover.'],
    ['detail_page_outline', 'Outline a detail page', 'Draft a product detail page outline and identify information still needed.', 'Your detail page outline is ready. Check the missing information before publishing.'],
  ] as const) {
    server.registerTool(name, { title, description, inputSchema: contentInput.shape,
      annotations: { ...annotations, idempotentHint: false, openWorldHint: Boolean(env.LLM_API_KEY) } }, async input => {
      try { const { mode, data } = await generate(name, input, env); return wrap(speech, data, mode); }
      catch { return { isError: true, ...wrap(env.LLM_API_KEY ? 'The live writing service could not complete this request. Please try again or check your provider settings.' : 'The demo draft could not be created. Check your product facts and try again.', { code: 'GENERATION_FAILED' }, env.LLM_API_KEY ? 'live-error' : 'demo-error') }; }
    });
  }
  return server;
}
