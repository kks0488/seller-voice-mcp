export default function status(_req: unknown, res: { setHeader: (k: string, v: string) => void; json: (v: unknown) => void }) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ protocol: '2025-11-25', generation: process.env.LLM_API_KEY ? 'live' : 'demo', authRequired: Boolean(process.env.MCP_AUTH_TOKEN) });
}
