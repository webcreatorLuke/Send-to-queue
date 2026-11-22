// FlowQ queue sender: serves the page and proxies /proxy/* to the FlowQ API (avoids browser CORS).
// Run:  node server.js   then open http://localhost:3000   (needs Node 18+)
const http = require('http'), fs = require('fs'), path = require('path');
const TARGET = (process.env.FLOWQ_API || 'https://api.infinityflow3d.com').replace(/\/$/, '');
const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'flowq-queue.html');

http.createServer(async (req, res) => {
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
