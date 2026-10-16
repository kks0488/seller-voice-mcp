const $ = id => document.getElementById(id);
const examples = {
  margin: "What's my break-even ROAS if I sell at 29,000 won with 11,000 cost?",
  audit: 'Check my listing: This bamboo cutting board is guaranteed antibacterial and cures food allergies.',
  headlines: 'Give me three ad headlines for the bamboo cutting board',
  shorts: 'Draft a 30-second shorts script for the bamboo cutting board',
  outline: 'Create a detail page outline for the bamboo cutting board',
};
let requestId = 0, connected = false, busy = false, tools = [], protocol = '2025-11-25';
const logs = [];
function trace(message) { logs.push(message); $('trace-lines').textContent = logs.slice(-4).join('\n'); }
async function rpc(method, params, notification = false) {
  const body = { jsonrpc: '2.0', ...(notification ? {} : { id: ++requestId }), method, params };
  const token = $('token').value.trim();
  const response = await fetch('/api/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': protocol, ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 401 ? 'This server requires a bearer token. Enter it in connection settings.' : `MCP request failed (HTTP ${response.status}).`);
  if (notification) return;
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message);
  return payload.result;
}
async function connect() {
  const hello = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'seller-voice-web', version: '1.0.0' } });
  protocol = hello.protocolVersion;
  await rpc('notifications/initialized', {}, true);
  trace(`initialize → ${hello.serverInfo.name} · protocol ${protocol} · Streamable HTTP`);
  const listed = await rpc('tools/list', {}); tools = listed.tools;
  trace(`tools/list → ${tools.length} seller tools available · stateless transport`);
  $('connection').textContent = `${tools.length} tools connected`;
  connected = true;
}
function parseRequest(query) {
  const q = query.toLowerCase();
  if (/margin|roas|break.even|profit/.test(q)) {
    const num = '(\\d[\\d,]*(?:\\.\\d+)?)';
    const get = pattern => { const m = q.match(new RegExp(pattern)); return m ? Number(m[1].replaceAll(',', '')) : undefined; };
    const price = get(`(?:sell(?:ing)?(?: price)?(?: at| for)?|price(?: is| of)?|priced at)\\s*[:$₩€]?\\s*${num}`);
    const cost = get(`(?:cost(?:s)?(?: is| of)?|cost of)\\s*[:$₩€]?\\s*${num}`) ?? get(`${num}\\s*(?:won|krw|dollars)?\\s*(?:cost|unit cost)`);
    if (!(price > 0) || cost === undefined) throw new Error('Please include a selling price and cost, for example: “Check margin, price 29,000 and cost 11,000.”');
    return { name: 'margin_check', arguments: { price, cost, feePct: get(`(?:fee|fees)\\s*${num}`) ?? 0, shipping: get(`shipping\\s*[:$₩€]?\\s*${num}`) ?? 0, adCost: get(`(?:ads|ad cost)\\s*[:$₩€]?\\s*${num}`) ?? 0, currency: /usd|dollar|\$/.test(q) ? 'USD' : /eur|€/.test(q) ? 'EUR' : 'KRW' } };
  }
  if (/audit|listing|risky|claims/.test(q)) {
    const listing = query.replace(/^.*?(?:listing|claims)\s*[:\-]\s*/i, '').trim();
    return { name: 'listing_audit', arguments: { listing, facts: {} } };
  }
  const name = /headline|ad copy/.test(q) ? 'ad_headlines' : /shorts?|script|video/.test(q) ? 'shorts_script' : /outline|detail page/.test(q) ? 'detail_page_outline' : null;
  if (!name) throw new Error('Try asking for a margin check, listing audit, ad headlines, shorts script or detail page outline.');
  const product = query.match(/\bfor\s+(?:the\s+|a\s+)?(.+?)[.!?]?$/i)?.[1];
  if (!product) throw new Error('Add the product name after “for”, for example: “Draft three ad headlines for a bamboo cutting board.”');
  const facts = $('facts').value.trim();
  if (!facts) throw new Error('Add your known product facts in the product settings first.');
  return { name, arguments: { product, facts, audience: 'everyday shoppers' } };
}
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function item(label, body) { const node = el('div', undefined, 'output-item'); node.append(el('small', label), el('p', body)); return node; }
function render(name, output, query) {
  const result = $('result'); result.replaceChildren();
  result.append(el('p', `YOU ASKED  /  ${query}`, 'request-quote'));
  const speech = el('div', undefined, 'answer-speech'); speech.append(el('span', '✧'), el('p', output.speech)); result.append(speech);
  const data = output.data;
  const list = el('div', undefined, 'output-list');
  $('result-mode').textContent = output.mode === 'demo' ? 'DEMO · TEMPLATE DRAFT' : output.mode === 'demo-fallback' ? 'DEMO FALLBACK · LIVE UNAVAILABLE' : output.mode.toUpperCase();
  if (name === 'margin_check') {
    const metrics = el('div', undefined, 'metrics');
    const metric = (label, value, primary = false) => { const card = el('div', undefined, `metric${primary ? ' primary' : ''}`); card.append(el('small', label), el('strong', value)); return card; };
    const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: data.currency, maximumFractionDigits: data.currency === 'KRW' ? 0 : 2 }).format(value);
    metrics.append(metric('BREAK-EVEN ROAS', data.breakEvenRoas === null ? 'Unavailable' : `${data.breakEvenRoas.toFixed(2)}×`, true), metric('UNIT PROFIT', money(data.unitProfit)), metric('PROFIT MARGIN', `${data.marginPct.toFixed(1)}%`));
    result.append(metrics, el('div', `Price ${money(data.price)} − cost ${money(data.cost)} − fees ${money(data.fee)} − shipping ${money(data.shipping)} − ads ${money(data.adCost)}. ROAS uses profit before ads. Excludes taxes, overhead and returns.`, 'assumptions'));
    if (data.warnings.length) result.append(el('p', data.warnings.join(' '), 'missing'));
  } else if (name === 'listing_audit') {
    data.findings.forEach(f => list.append(item(`${f.priority.toUpperCase()} · ${f.issue}`, `“${f.excerpt}” — ${f.fix}`)));
    if (!data.findings.length) list.append(item('NO CLAIM PATTERNS FOUND', 'This limited scan does not establish compliance.'));
    if (data.missingFacts.length) list.append(el('div', `Missing fact fields: ${data.missingFacts.join(', ')}. Provide these in the MCP facts object for a complete check.`, 'missing'));
    list.append(el('div', data.note, 'assumptions')); result.append(list);
  } else if (name === 'ad_headlines') {
    data.headlines.forEach((h, i) => list.append(item(`HEADLINE 0${i + 1}`, h))); result.append(list);
  } else if (name === 'shorts_script') {
    data.scenes.forEach(s => list.append(item(`${s.start}–${s.end}s · ${s.visual}`, s.voiceover))); list.append(item('CALL TO ACTION', data.cta)); result.append(list);
  } else {
    data.sections.forEach(s => list.append(item(s.title.toUpperCase(), s.body))); list.append(el('div', data.needsInfo.join(' '), 'missing')); result.append(list);
  }
  if (output.notice) result.append(el('div', output.notice, 'missing'));
  if (output.mode === 'demo') result.append(el('div', 'Deterministic demo template · no LLM API call was made. Your supplied product facts are used as written.', 'assumptions'));
  if ($('speak-toggle').getAttribute('aria-pressed') === 'true' && 'speechSynthesis' in window) {
    speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(output.speech); utterance.lang = 'en-US'; speechSynthesis.speak(utterance);
  }
}
$('ask-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const query = $('question').value.trim(); if (!query) return;
  busy = true; $('send').disabled = true; $('send').textContent = 'Working…';
  try {
    const call = parseRequest(query);
    if (!connected) await connect();
    if (!tools.some(t => t.name === call.name)) throw new Error('Requested tool is not available on this server.');
    trace(`tools/call → ${call.name}(${JSON.stringify(call.arguments)})`);
    const started = performance.now();
    const response = await rpc('tools/call', call);
    const output = response.structuredContent || JSON.parse(response.content[0].text);
    $('payload-content').textContent = JSON.stringify({ request: { method: 'tools/call', params: call }, response }, null, 2);
    if (response.isError) throw new Error(output.speech);
    trace(`← ${call.name} · ${Math.round(performance.now() - started)}ms · ${output.mode} · speech + structured data`);
    render(call.name, output, query);
  } catch (error) { $('result').replaceChildren(el('div', error.message, 'error')); $('result-mode').textContent = 'NEEDS ATTENTION'; trace(`error → ${error.message}`); }
  finally { busy = false; $('send').disabled = false; $('send').textContent = 'Ask Seller Voice ↗'; }
});
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { $('question').value = examples[button.dataset.example]; $('question').focus(); }));
$('token').addEventListener('input', () => { connected = false; });
$('speak-toggle').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) { $('voice-status').textContent = 'Spoken replies are unavailable in this browser.'; return; }
  const active = $('speak-toggle').getAttribute('aria-pressed') !== 'true';
  $('speak-toggle').setAttribute('aria-pressed', String(active)); $('speak-toggle').textContent = active ? '◖ Audio on' : '◖ Audio off';
  if (!active) speechSynthesis.cancel();
});
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition, listening = false;
function voice() {
  if (!SpeechRecognition) { $('voice-status').textContent = 'Voice input is unavailable here. Type your request below.'; $('question').focus(); return; }
  if (listening) { recognition.stop(); return; }
  recognition = new SpeechRecognition(); recognition.lang = 'en-US'; recognition.interimResults = false;
  recognition.onstart = () => { listening = true; $('mic').classList.add('listening'); $('voice-status').textContent = 'Listening… tap again to stop'; };
  recognition.onresult = event => { $('question').value = event.results[0][0].transcript; $('voice-status').textContent = 'Ready — review your words, then send'; };
  recognition.onerror = () => { $('voice-status').textContent = 'Microphone unavailable. You can type your request.'; };
  recognition.onend = () => { listening = false; $('mic').classList.remove('listening'); if ($('voice-status').textContent.startsWith('Listening')) $('voice-status').textContent = 'Type a question or use your voice'; };
  try { recognition.start(); } catch { $('voice-status').textContent = 'Voice input could not start. Type your request.'; }
}
$('mic').addEventListener('click', voice); $('hero-mic').addEventListener('click', voice);
async function boot() {
  try {
    const status = await (await fetch('/api/status')).json();
    $('mode-badge').textContent = status.generation === 'demo' ? 'DEMO MODE · NO API KEY' : 'LIVE WRITING MODE';
    if (status.authRequired) { $('connection').textContent = 'Token required'; $('voice-status').textContent = 'Enter the MCP token in connection settings'; trace('Authentication enabled · enter a token to connect.'); return; }
    await connect();
  } catch (error) { $('connection').textContent = 'Connection needs attention'; trace(error.message); }
}
boot();
