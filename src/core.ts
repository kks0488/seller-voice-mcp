import { z } from 'zod';

const text = z.string().trim().min(1).max(4000);
const money = z.number().finite().min(0).max(1e12);
export const marginInput = z.object({
  price: money.positive(), cost: money, feePct: z.number().min(0).max(100).default(0),
  shipping: money.default(0), adCost: money.default(0), currency: z.enum(['KRW', 'USD', 'EUR']).default('KRW'),
});
export const auditInput = z.object({
  listing: text,
  facts: z.object({ material: text.optional(), dimensions: text.optional(), shipping: text.optional(), returns: text.optional() }).default({}),
});
export const contentInput = z.object({ product: text.max(100), facts: text.max(3000), audience: text.max(200).default('everyday shoppers') });

// Ported from commerce-content-engine/src/core.js, computeMargin (MIT).
// Copyright (c) 2026 Kyoungsoo Kim. Same formula; boundary validation is now Zod.
export function computeMargin(raw: unknown) {
  const { currency, ...values } = marginInput.parse(raw);
  const { price, cost, feePct, shipping, adCost } = values;
  const fee = price * feePct / 100;
  const profitBeforeAds = price - cost - fee - shipping;
  const unitProfit = profitBeforeAds - adCost;
  const marginPct = unitProfit / price * 100;
  const warnings: string[] = [];
  if (marginPct < 15) warnings.push('Margin is below 15%. Review costs before scaling ads.');
  if (unitProfit <= 0) warnings.push('Zero or negative unit profit. Each sale does not contribute profit.');
  if (profitBeforeAds <= 0) warnings.push('Break-even ROAS is unavailable: profit before ads must be positive.');
  return { ...values, currency, fee, profitBeforeAds, unitProfit, marginPct,
    breakEvenRoas: profitBeforeAds > 0 ? price / profitBeforeAds : null, warnings };
}

export function auditListing(raw: unknown) {
  const { listing, facts } = auditInput.parse(raw);
  const rules = [
    { regex: /\b(cures?|treats?|prevents?)\b|치료|완치|예방/gi, issue: 'Medical or disease claim', fix: 'Remove the claim unless it is permitted and supported by evidence.' },
    { regex: /\b(guaranteed|100\s*%\s*(?:safe|effective)|risk[- ]free)\b|무조건|100\s*%\s*(?:안전|효과)/gi, issue: 'Absolute guarantee', fix: 'Replace with specific, supported product facts.' },
    { regex: /\b(certified|FDA[- ]?approved|clinically proven|best[- ]selling)\b|#\s*1\b|인증|임상|1위/gi, issue: 'Claim needs evidence', fix: 'Provide verifiable evidence and scope, or remove the claim.' },
    { regex: /\b(antibacterial|kills?\s+(?:all\s+)?(?:germs|bacteria))\b|항균|살균/gi, issue: 'Antimicrobial claim', fix: 'Verify applicable rules and supporting test conditions before publication.' },
  ];
  const findings = rules.flatMap(rule => [...listing.matchAll(rule.regex)].slice(0, 10).map(m => ({
    priority: 'high' as const, issue: rule.issue, excerpt: m[0], fix: rule.fix,
  })));
  const missingFacts = (['material', 'dimensions', 'shipping', 'returns'] as const).filter(key => !facts[key]);
  return { findings, missingFacts, status: findings.length ? 'review' : 'no-patterns-found',
    note: 'A limited pattern check, not legal approval; negated or quoted claims may also be flagged. Missing facts refer to the supplied facts fields.' };
}

export const headlineOutput = z.object({ headlines: z.array(text.max(40)).length(3) }).refine(
  ({ headlines }) => new Set(headlines.map(h => h.toLowerCase())).size === 3, 'Headlines must be distinct.');
export const scriptOutput = z.object({ scenes: z.array(z.object({
  start: z.number().int().min(0), end: z.number().int().max(30), visual: text, voiceover: text,
  onScreen: text.max(60),
})).min(3).max(8), cta: text }).superRefine(({ scenes }, ctx) => {
  if (scenes[0].start !== 0 || scenes[0].end > 2 || scenes.at(-1)!.end !== 30 || scenes.some((s, i) => s.end <= s.start || (i > 0 && s.start !== scenes[i - 1].end)))
    ctx.addIssue({ code: 'custom', message: 'Scenes must cover exactly 0–30 seconds with no gaps or overlaps.' });
});
export const outlineOutput = z.object({ sections: z.array(z.object({ title: text, body: text })).min(4).max(8), needsInfo: z.array(text).max(12) });
export const generatedSchemas = { ad_headlines: headlineOutput, shorts_script: scriptOutput, detail_page_outline: outlineOutput };
export type ContentTool = keyof typeof generatedSchemas;

export function demoContent(tool: ContentTool, raw: unknown) {
  const { product, facts } = contentInput.parse(raw);
  // Deterministic templates use supplied facts; no fabricated product performance.
  const shortProduct = product.length <= 24 ? product : 'the product';
  if (tool === 'ad_headlines') return { headlines: [`Meet ${shortProduct}`, `A closer look: ${shortProduct}`, `Explore ${shortProduct}`] };
  if (tool === 'shorts_script') return { scenes: [
    { start: 0, end: 2, visual: 'Open on the product on a clean surface.', voiceover: 'Take a closer look.', onScreen: 'Your next everyday pick?' },
    { start: 2, end: 12, visual: `Show ${product} from two angles.`, voiceover: 'Let’s take a closer look at the details.', onScreen: 'See the details' },
    { start: 12, end: 23, visual: `Show a close-up of supplied facts: ${facts}`, voiceover: 'Check the product details to see if it fits your routine.', onScreen: 'Check the supplied specifications' },
    { start: 23, end: 30, visual: 'End on the product and a detail-page link.', voiceover: 'Review the specifications and purchase conditions before choosing.', onScreen: 'Explore the product details' },
  ], cta: 'See the product details.' };
  return { sections: [
    { title: 'Meet the product', body: product }, { title: 'Supplied product facts', body: facts },
    { title: 'A closer look', body: 'Add original photographs showing the actual product and its dimensions.' },
    { title: 'Before you order', body: 'Confirm care, shipping and return conditions with the seller.' },
  ], needsInfo: ['Verify dimensions, care instructions, shipping and return terms before publishing.'] };
}
