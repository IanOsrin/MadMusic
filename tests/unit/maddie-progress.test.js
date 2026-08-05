// Maddie's waiting line must tell the truth: "checking the shelves" while she
// is on the shelves, "searching the web" while she is on the web. The server
// reports the phase over SSE, but only to clients that ask for it — everyone
// else must still get the single JSON body the endpoint always returned.
import { describe, it, expect, vi } from 'vitest';
import { progressChannel, usedWebSearch } from '../../routes/maddie.js';

function fakeReq(accept) {
  return { get: (h) => (h.toLowerCase() === 'accept' ? accept : undefined) };
}

function fakeRes() {
  const res = {
    written: [], headers: null, code: null, ended: false, jsonBody: undefined,
    status(c) { res.code = c; return res; },
    set(h) { res.headers = h; return res; },
    flushHeaders() {},
    write(chunk) { res.written.push(chunk); return true; },
    end() { res.ended = true; },
    json(body) { res.jsonBody = body; return res; },
  };
  return res;
}

const frames = (res) => res.written.join('').trim().split('\n\n').map((f) => ({
  event: (f.match(/^event: (.*)$/m) || [])[1],
  data: JSON.parse((f.match(/^data: (.*)$/m) || [])[1]),
}));

describe('usedWebSearch', () => {
  it('spots the server-side web tool by its use block', () => {
    expect(usedWebSearch([{ type: 'server_tool_use', name: 'web_search', input: {} }])).toBe(true);
  });

  it('spots it by its result block, including the versioned form', () => {
    expect(usedWebSearch([{ type: 'web_search_tool_result' }])).toBe(true);
    expect(usedWebSearch([{ type: 'web_search_tool_result_error' }])).toBe(true);
  });

  it('does not mistake her own shelf tools for a trip to the web', () => {
    expect(usedWebSearch([
      { type: 'text', text: 'let me look' },
      { type: 'tool_use', name: 'search_shelves', input: { artist: 'Mahlathini' } },
    ])).toBe(false);
    expect(usedWebSearch([])).toBe(false);
    expect(usedWebSearch(undefined)).toBe(false);
  });
});

describe('progressChannel — plain clients', () => {
  it('sends one JSON body and never opens a stream', () => {
    const res = fakeRes();
    const out = progressChannel(fakeReq(undefined), res);
    out.status('web');                       // must be silently dropped
    out.done({ reply: 'here you go', tracks: [] });
    expect(res.written).toEqual([]);
    expect(res.jsonBody).toEqual({ reply: 'here you go', tracks: [] });
    expect(res.ended).toBe(false);
  });

  it('keeps real HTTP status codes on failures', () => {
    const res = fakeRes();
    progressChannel(fakeReq('application/json'), res).fail(429, { error: 'breather' });
    expect(res.code).toBe(429);
    expect(res.jsonBody).toEqual({ error: 'breather' });
  });
});

describe('progressChannel — streaming clients', () => {
  it('streams each phase change, then the payload', () => {
    const res = fakeRes();
    const out = progressChannel(fakeReq('text/event-stream'), res);
    out.status('shelves');
    out.status('web');
    out.done({ reply: 'not on our shelves, but the story goes…', tracks: [] });

    expect(frames(res).map((f) => [f.event, f.data.phase])).toEqual([
      ['status', 'shelves'], ['status', 'web'], ['done', undefined],
    ]);
    expect(frames(res)[2].data.reply).toMatch(/story goes/);
    expect(res.ended).toBe(true);
  });

  it('asks proxies not to buffer — a held-back status defeats the point', () => {
    const res = fakeRes();
    progressChannel(fakeReq('text/event-stream'), res).status('web');
    expect(res.code).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/text\/event-stream/);
    expect(res.headers['X-Accel-Buffering']).toBe('no');
    expect(res.headers['Cache-Control']).toMatch(/no-transform/);
  });

  it('sets the headers once, however many events follow', () => {
    const res = fakeRes();
    const out = progressChannel(fakeReq('text/event-stream'), res);
    const spy = vi.spyOn(res, 'set');
    out.status('shelves'); out.status('web'); out.done({ reply: 'x' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('still uses a real status code if it fails before the stream opens', () => {
    const res = fakeRes();
    progressChannel(fakeReq('text/event-stream'), res).fail(400, { error: 'say something' });
    expect(res.code).toBe(400);
    expect(res.jsonBody).toEqual({ error: 'say something' });
    expect(res.written).toEqual([]);
  });

  it('reports a late failure as an error event, the stream already being open', () => {
    const res = fakeRes();
    const out = progressChannel(fakeReq('text/event-stream'), res);
    out.status('web');
    out.fail(500, { error: 'stepped away' });
    const last = frames(res).pop();
    expect(last.event).toBe('error');
    expect(last.data).toEqual({ error: 'stepped away' });
    expect(res.ended).toBe(true);
  });

  it('frames payloads that contain newlines as a single event', () => {
    const res = fakeRes();
    const out = progressChannel(fakeReq('text/event-stream'), res);
    out.done({ reply: 'line one\n\nline two', tracks: [] });
    expect(frames(res)).toHaveLength(1);          // \n\n inside JSON must not split the frame
    expect(frames(res)[0].data.reply).toBe('line one\n\nline two');
  });
});
