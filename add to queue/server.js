// FlowQ queue sender: serves the page and proxies /proxy/* to the FlowQ API (avoids browser CORS).
// Run:  node server.js   then open http://localhost:3000   (needs Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
const TARGET = (process.env.FLOWQ_API || 'https://api.infinityflow3d.com').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'flowq-queue.html');


// Visit http://localhost:3000/discover to dump what the FlowQ API docs reveal about endpoint paths.
async function discover() {
  const out = [];
  const get = async (p) => {
    try {
      const r = await fetch(p.startsWith('http') ? p : TARGET + p);
      return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
    } catch (e) { return { status: 0, type: '', text: '' }; }
  };
  const docs = await get('/docs');
  out.push('GET /docs -> ' + docs.status + ' (' + docs.type + ', ' + docs.text.length + ' bytes)');
  out.push('--- first 1500 chars of /docs ---\n' + docs.text.slice(0, 1500));
  const refs = new Set();
  for (const m of docs.text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) refs.add(m[1]);
  for (const m of docs.text.matchAll(/["'`]([^"'`\s]*(?:openapi|swagger|api-docs|spec)[^"'`\s]*)["'`]/gi)) refs.add(m[1]);
  out.push('--- references found in /docs ---\n' + [...refs].join('\n'));

  const cands = ['/openapi.json','/openapi.yaml','/swagger.json','/swagger.yaml','/api-docs','/api-docs.json',
    '/v1/openapi.json','/v2/openapi.json','/docs/openapi.json','/docs/swagger.json','/docs.json',
    '/api/openapi.json','/api/v1/openapi.json','/api/v2/openapi.json','/api/swagger.json','/api/docs',
    '/spec','/spec.json','/schema','/api/schema','/public/openapi.json','/public/v1/openapi.json','/api/public/openapi.json'];
  for (const r of refs) {
    if (/openapi|swagger|spec|api-docs/i.test(r) && !cands.includes(r)) cands.push(r.startsWith('http') || r.startsWith('/') ? r : '/' + r.replace(/^\.\//, ''));
  }
  out.push('--- spec candidates ---');
  for (const c of cands) {
    const r = await get(c);
    let note = String(r.status);
    if (r.status === 200 && /"paths"|^paths:/m.test(r.text)) {
      note += ' SPEC FOUND';
      const paths = [...r.text.matchAll(/"(\/[^"\s]*)"\s*:\s*\{\s*"(get|post|put|patch|delete)"/g)].map(m => m[1]);
      out.push(c + ' -> ' + note);
      out.push('PATHS:\n' + [...new Set(paths)].join('\n'));
      continue;
    }
    out.push(c + ' -> ' + note);
  }

  out.push('--- API-like paths inside the docs page scripts ---');
  const found = new Set();
  for (const r of refs) {
    if (!/\.js(\?|$)/.test(r)) continue;
    const u = r.startsWith('http') ? r : r.startsWith('/') ? TARGET + r : null;
    if (!u) continue;
    const js = (await get(u)).text.slice(0, 3000000);
    for (const m of js.matchAll(/["'`](\/(?:api\/)?v\d\/[A-Za-z0-9_\-\/{}.:]+)["'`]/g)) found.add(m[1]);
  }
  out.push([...found].slice(0, 300).join('\n') || '(none)');
  return out.join('\n\n');
}

// Visit http://localhost:3000/spec to print FlowQ's definition of the queue endpoints.
function yamlPaths(t) {
  const L = t.split('\n'); let i = L.findIndex(l => /^paths:\s*$/.test(l)); const P = {};
  if (i < 0) return P; let cur = null, m = null;
  for (i++; i < L.length; i++) {
    const l = L[i]; if (/^\S/.test(l)) break;
    let a = l.match(/^  ['"]?(\/[^'"\s]*?)['"]?:\s*$/); if (a) { cur = a[1]; P[cur] = {}; m = null; continue; }
    a = l.match(/^    (get|post|put|patch|delete):\s*$/); if (a && cur) { m = a[1]; P[cur][m] = []; continue; }
    if (cur && m) P[cur][m].push(l);
  }
  return P;
}
function yamlSchema(t, name) {
  const L = t.split('\n'); const i = L.findIndex(l => new RegExp('^    [\'"]?' + name.replace(/[.]/g, '\\.') + '[\'"]?:\\s*$').test(l));
  if (i < 0) return []; const o = [];
  for (let k = i + 1; k < L.length; k++) { if (L[k].trim() && !/^     /.test(L[k])) break; o.push(L[k]); }
  return o;
}
async function specDump(filter) {
  const FILT = new RegExp(filter || 'queue', 'i');
  const r = await fetch(TARGET + '/schema', { headers: { Accept: 'application/vnd.oai.openapi+json, application/json;q=0.9, */*;q=0.5' } });
  const text = await r.text();
  const out = ['GET /schema -> ' + r.status + ' (' + text.length + ' bytes)'];
  let json = null; try { json = JSON.parse(text); } catch (e) {}
  const names = new Set();
  if (json) {
    const paths = json.paths || {}, keys = Object.keys(paths);
    out.push('ALL PATHS:\n' + keys.map(k => Object.keys(paths[k]).join('/').toUpperCase() + ' ' + k).join('\n'));
    const grab = o => { for (const m of JSON.stringify(o).matchAll(/#\/components\/schemas\/([\w.\-]+)/g)) names.add(m[1]); };
    for (const k of keys.filter(k => FILT.test(k))) { out.push('=== ' + k + ' ===\n' + JSON.stringify(paths[k], null, 1).slice(0, 4000)); grab(paths[k]); }
    const schemas = (json.components || {}).schemas || {};
    for (let d = 0; d < 3; d++) for (const n of [...names]) if (schemas[n]) grab(schemas[n]);
    for (const n of names) if (schemas[n]) out.push('--- schema ' + n + ' ---\n' + JSON.stringify(schemas[n], null, 1).slice(0, 3000));
  } else {
    const P = yamlPaths(text), keys = Object.keys(P);
    out.push('ALL PATHS:\n' + keys.map(k => Object.keys(P[k]).join('/').toUpperCase() + ' ' + k).join('\n'));
    const grab = t => { for (const m of t.matchAll(/#\/components\/schemas\/([\w.\-]+)/g)) names.add(m[1]); };
    for (const k of keys.filter(k => FILT.test(k)))
      for (const m of Object.keys(P[k])) { const b = P[k][m].join('\n'); out.push('=== ' + m.toUpperCase() + ' ' + k + ' ===\n' + b.slice(0, 4000)); grab(b); }
    for (let d = 0; d < 3; d++) for (const n of [...names]) grab(yamlSchema(text, n).join('\n'));
    for (const n of names) out.push('--- schema ' + n + ' ---\n' + yamlSchema(text, n).join('\n').slice(0, 3000));
  }
  return out.join('\n\n');
}

// Bambu A1/P1 camera -> browser. The printer sends JPEG frames over TLS on port 6000;
// this turns them into an MJPEG stream a normal <img> tag can show.
// Use:  /camera/bambu?ip=PRINTER-IP&code=ACCESS-CODE   (LAN addresses only)
const tls = require('tls');
function bambuCamera(req, res, q) {
  const ip = q.get('ip') || '', code = q.get('code') || '';
  const bad = (m) => { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end(m); };
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(ip))
    return bad('ip must be a LAN address like 192.168.1.50');
  if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return bad('access code looks wrong');
  const auth = Buffer.alloc(80);
  auth.writeUInt32LE(0x40, 0); auth.writeUInt32LE(0x3000, 4);
  auth.write('bblp', 16, 'ascii'); auth.write(code, 48, 'ascii');
  const sock = tls.connect({ host: ip, port: 6000, rejectUnauthorized: false });
  let buf = Buffer.alloc(0), started = false, done = false;
  const end = (msg) => {
    if (done) return; done = true; sock.destroy();
    if (!started && !res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain' }); return res.end(msg || 'Camera closed the connection (check IP, access code, LAN Mode Liveview).'); }
    res.end();
  };
  sock.setTimeout(15000, () => end('Camera timed out'));
  sock.on('secureConnect', () => sock.write(auth));
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 16) {
      const size = buf.readUInt32LE(0) & 0xffffff;
      if (size === 0 || size > 5000000) { buf = Buffer.alloc(0); break; }
      if (buf.length < 16 + size) break;
      const jpg = buf.subarray(16, 16 + size); buf = buf.subarray(16 + size);
      if (jpg[0] !== 0xff || jpg[1] !== 0xd8) continue;
      if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache' }); }
      res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ' + jpg.length + '\r\n\r\n');
      res.write(jpg); res.write('\r\n');
    }
  });
  sock.on('error', (e) => end('Could not reach the camera: ' + e.message));
  sock.on('close', () => end());
  res.on('close', () => { done = true; sock.destroy(); });
}

const STORE = path.join(__dirname, 'flowq-store.json');   // saved camera entries live here
async function storeRoute(req, res) {
  if (req.method === 'POST') {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 200000) { res.writeHead(413); return res.end('too big'); } chunks.push(c); }
    try {
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!j || typeof j.cams !== 'object' || Array.isArray(j.cams)) throw new Error('bad shape');
      fs.writeFileSync(STORE, JSON.stringify({ cams: j.cams }, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
    } catch (e) { res.writeHead(400); return res.end('bad request'); }
  }
  let out = '{"cams":{}}';
  try { out = fs.readFileSync(STORE, 'utf8'); } catch (e) {}
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(out);
}

http.createServer(async (req, res) => {
  if (req.url === '/store') return storeRoute(req, res);
  if (req.url.startsWith('/camera/bambu')) return bambuCamera(req, res, new URL(req.url, 'http://x').searchParams);
  if (req.url === '/spec' || req.url.startsWith('/spec?')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    try { const f = new URL(req.url, 'http://x').searchParams.get('f'); return res.end(await specDump(f)); } catch (e) { return res.end('Error: ' + e.message); }
  }
  if (req.url === '/discover') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(await discover());
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(PAGE).pipe(res);
  }
  if (req.url.startsWith('/proxy/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = {};
    for (const h of ['x-api-key', 'authorization', 'content-type', 'accept'])
      if (req.headers[h]) headers[h] = req.headers[h];
    try {
      const r = await fetch(TARGET + req.url.slice('/proxy'.length), {
        method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
      });
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' });
      return res.end(out);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end('Proxy could not reach FlowQ: ' + e.message);
    }
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('FlowQ sender running at http://localhost:' + PORT));
