import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * A tiny local stand-in for the Messages API, used only to prove the Agent SDK
 * wiring works with no key and no network. First turn: call one tool. Second
 * turn (after a tool result): finish with a sentence. Streams SSE like the API.
 */
export function startFakeAnthropic(toolCall: { name: string; input: Record<string, unknown> }, port = 0): Promise<{ url: string; requests: any[]; close: () => void }> {
  const requests: any[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    requests.push({ path: req.url, body: parsed });
    if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 100 }));
      return;
    }
    const msgs = parsed.messages ?? [];
    const hadResult = msgs.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'tool_result'));
    const toolName = (parsed.tools ?? []).map((t: any) => t.name).find((n: string) => n.endsWith(toolCall.name)) ?? toolCall.name;
    const usage = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 };
    const events: [string, unknown][] = [['message_start', { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage } }]];
    if (!hadResult) {
      events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fake1', name: toolName, input: {} } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolCall.input) } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 80 } }]);
    } else {
      events.push(['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]);
      events.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Drafted the proposal for the stylist to send.' } }]);
      events.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
      events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }]);
    }
    events.push(['message_stop', { type: 'message_stop' }]);
    if (parsed.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_fake', type: 'message', role: 'assistant', model: parsed.model, content: hadResult ? [{ type: 'text', text: 'Done.' }] : [{ type: 'tool_use', id: 'toolu_fake1', name: toolName, input: toolCall.input }], stop_reason: hadResult ? 'end_turn' : 'tool_use', usage }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, requests, close: () => server.close() });
    });
  });
}
