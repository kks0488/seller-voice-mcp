import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
// Run on pilot only. CAPTURE_URL can point to the deployed site for final verification.
const url = process.env.CAPTURE_URL || 'http://127.0.0.1:3000';
await mkdir('media', { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: 'media', size: { width: 1920, height: 1080 } }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
const calls: { tool: string; mode: string; speech: string; usage?: unknown; notice?: string }[] = [];
try {
  await page.goto(url); await page.getByText('5 tools connected').waitFor();
  await page.screenshot({ path: 'media/01-voice-desk.png', fullPage: false });
  for (const [key, name] of [['margin', 'margin_check'], ['headlines', 'ad_headlines'], ['audit', 'listing_audit'], ['shorts', 'shorts_script'], ['outline', 'detail_page_outline']] as const) {
    await page.locator(`[data-example="${key}"]`).first().click();
    await page.getByRole('button', { name: 'Ask Seller Voice' }).click();
    await page.waitForFunction(expected => document.getElementById('payload-content')!.textContent!.includes(`"name": "${expected}"`), name);
    await page.waitForFunction(() => !(document.getElementById('send') as HTMLButtonElement).disabled, undefined, { timeout: 45000 });
    const payload = JSON.parse((await page.locator('#payload-content').textContent())!);
    if (payload.response.isError) throw new Error(`Tool failed: ${name}`);
    const output = payload.response.structuredContent;
    if (process.env.REQUIRE_LIVE === '1' && ['ad_headlines', 'shorts_script', 'detail_page_outline'].includes(name) && output.mode !== 'live') throw new Error(`Expected live ${name}: ${output.notice || output.mode}`);
    calls.push({ tool: name, mode: output.mode, speech: output.speech, ...(output.usage ? { usage: output.usage } : {}), ...(output.notice ? { notice: output.notice } : {}) });
    await page.screenshot({ path: `media/0${calls.length + 1}-${key}.png`, fullPage: false });
    if (name === 'margin_check') {
      await page.locator('#payload summary').click();
      await page.locator('#payload').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'media/08-mcp-payload.png', fullPage: false });
      await page.waitForTimeout(1800);
      await page.locator('#payload summary').click();
      await page.locator('h1').scrollIntoViewIfNeeded();
    }
    await page.waitForTimeout(1400);
  }
  // Check text fallback, unknown intent feedback, and actual DOM overflow on mobile.
  await page.locator('#question').fill('Check margin without numbers');
  await page.getByRole('button', { name: 'Ask Seller Voice' }).click();
  await page.getByText('Please include a selling price and cost', { exact: false }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-example="margin"]').last().click();
  await page.getByRole('button', { name: 'Ask Seller Voice' }).click();
  await page.waitForFunction(() => !(document.getElementById('send') as HTMLButtonElement).disabled);
  await page.getByText('1.61×', { exact: true }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile horizontal overflow');
  await page.screenshot({ path: 'media/07-mobile.png', fullPage: true });
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile('media/verification.json', JSON.stringify({ url, capturedAt: new Date().toISOString(), viewport: '1920x1080', calls, mobile: '390x844, no horizontal overflow', pageErrors: errors, note: 'Browser automation with text input; microphone, physical-device voice and Alexa+ account connection were not tested.' }, null, 2) + '\n');
} finally { await context.close(); await browser.close(); }
console.log(`Captured ${calls.length} real MCP tool flows.`);
