import { chromium } from 'playwright';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
// Run on pilot only. CAPTURE_URL can point to the deployed site for final verification.
if (process.platform === 'darwin') throw new Error('Run browser capture on pilot.');
const url = process.env.CAPTURE_URL || 'http://127.0.0.1:3000';
const scenarios = [['margin', 'margin_check'], ['headlines', 'ad_headlines'], ['audit', 'listing_audit'], ['shorts', 'shorts_script'], ['outline', 'detail_page_outline']] as const;
const selected = process.env.CAPTURE_TOOL;
if (selected && !scenarios.some(([, name]) => name === selected)) throw new Error('Unknown CAPTURE_TOOL');
const previous = selected ? JSON.parse(await readFile('media/verification.json', 'utf8')) : { calls: [], panels: {}, segments: [] };
await mkdir('media', { recursive: true });
const cached = (await readdir(path.join(homedir(), '.cache/ms-playwright'))).filter(n => n.startsWith('chromium_headless_shell-')).sort().reverse()[0];
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || path.join(homedir(), '.cache/ms-playwright', cached, 'chrome-headless-shell-linux64/chrome-headless-shell') });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1,
  recordVideo: { dir: 'media', size: { width: 1920, height: 1080 } }, reducedMotion: 'reduce' });
const epoch = Date.now();
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', e => errors.push(e.message));
const calls: { tool: string; capturedAt?: string; mode: string; model?: string; data: unknown; speech: string; usage?: unknown; notice?: string }[] = previous.calls.filter((c: { tool: string }) => c.tool !== selected);
const segments: { name: string; start: number; duration: number; seconds: number }[] = [];
const panels: Record<string, unknown> = previous.panels;
async function evidence(complete = false) {
  await writeFile('media/verification.json', JSON.stringify({ url, capturedAt: new Date().toISOString(), complete, viewport: '1920x1080', calls,
    segments: [...previous.segments.filter((s: { name: string }) => !segments.some(n => n.name === s.name)), ...segments], panels,
    mobile: complete ? '390x844, no horizontal overflow' : 'pending', pageErrors: errors,
    note: 'Real production MCP responses with smooth typed input; microphone, physical-device voice and Alexa+ account connection were not tested.' }, null, 2) + '\n');
}
async function scrollTo(selector: string) {
  await page.evaluate(selector => {
    const target = document.querySelector(selector)!;
    window.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + scrollY - 36), behavior: 'smooth' });
  }, selector);
  await page.waitForTimeout(900);
}
async function savePanels(key: string) {
  panels[key] = await page.evaluate(() => {
    const selectors = ['.result-panel', '#result', '#payload-content', '.output-item', '.answer-speech', '.metrics'];
    return selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)).map(node => {
      const b = node.getBoundingClientRect();
      return { selector, x: b.x, y: b.y, width: b.width, height: b.height, text: node.textContent, fontSize: getComputedStyle(node).fontSize };
    }));
  });
}
try {
  await page.goto(url); await page.getByText('5 tools connected').waitFor();
  await page.screenshot({ path: 'media/01-voice-desk.png', fullPage: false });
  for (const [index, [key, name]] of scenarios.entries()) {
    if (selected && name !== selected) continue;
    await page.locator(`[data-example="${key}"]`).first().click();
    const query = await page.locator('#question').inputValue();
    await page.locator('#question').fill('');
    await scrollTo('#ask-form');
    panels[`${key}-input`] = { question: await page.locator('#question').boundingBox(), send: await page.locator('#send').boundingBox() };
    const started = Date.now();
    await page.locator('#question').pressSequentially(query, { delay: 28 });
    await page.getByRole('button', { name: 'Ask Seller Voice' }).click();
    await page.waitForFunction(expected => document.getElementById('payload-content')!.textContent!.includes(`"name": "${expected}"`), name);
    await page.waitForFunction(() => !(document.getElementById('send') as HTMLButtonElement).disabled, undefined, { timeout: 45000 });
    const payload = JSON.parse((await page.locator('#payload-content').textContent())!);
    if (payload.response.isError) throw new Error(`Tool failed: ${name}`);
    const output = payload.response.structuredContent;
    if (process.env.REQUIRE_LIVE === '1' && ['ad_headlines', 'shorts_script', 'detail_page_outline'].includes(name) && output.mode !== 'live') throw new Error(`Expected live ${name}: ${output.notice || output.mode}`);
    calls.push({ tool: name, capturedAt: new Date().toISOString(), mode: output.mode, data: output.data, speech: output.speech, ...(output.model ? { model: output.model } : {}), ...(output.usage ? { usage: output.usage } : {}), ...(output.notice ? { notice: output.notice } : {}) });
    await scrollTo('.result-panel');
    await page.waitForTimeout(2200);
    const clipName = key === 'margin' ? 'margin-request' : `${key}-live`;
    segments.push({ name: clipName, start: (started - epoch) / 1000, duration: (Date.now() - started) / 1000, seconds: ['shorts', 'outline'].includes(key) ? 9 : 8 });
    await page.screenshot({ path: `media/0${index + 2}-${key}.png`, fullPage: false });
    await page.screenshot({ path: `media/${key}-review.png`, fullPage: false });
    await savePanels(key);
    if (name === 'margin_check') {
      await page.locator('#payload summary').click();
      await scrollTo('#payload');
      await page.screenshot({ path: 'media/08-mcp-payload.png', fullPage: false });
      await savePanels('payload');
      await page.waitForTimeout(1800);
      await page.locator('#payload summary').click();
      await page.locator('h1').scrollIntoViewIfNeeded();
    }
    await evidence();
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
  await evidence(true);
} finally {
  const rawVideo = await page.video()!.path();
  await context.close(); await browser.close();
  for (const segment of segments) {
    const speed = Math.min(1, (segment.seconds - 1) / segment.duration);
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(segment.start), '-i', rawVideo,
      '-vf', `trim=duration=${segment.duration},setpts=${speed}*(PTS-STARTPTS),fps=30,scale=1920:1080,setsar=1,tpad=stop_mode=clone:stop_duration=${segment.seconds}`,
      '-t', String(segment.seconds), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `media/${segment.name}.mp4`], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
}
console.log(`Captured ${segments.length} real MCP tool flows; ${calls.length} verified flows in media/verification.json.`);
