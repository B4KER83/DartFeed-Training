// Training Capture v0.1 — optional local HTTPS dev server.
//
// iOS Safari only grants camera access (getUserMedia) on a "secure
// context": https://, or http://localhost. A plain http://<lan-ip> won't
// work for on-device testing. This serves training_capture/ itself over
// HTTPS using a locally-trusted certificate (e.g. from mkcert) so an
// iPhone on the same Wi-Fi can open it and get camera access.
//
// The certificate/key are NOT part of this project — they're machine-
// specific secrets you generate yourself (see README "Testing on an
// iPhone") and point at via environment variables or CLI flags:
//
//   node serve-https.js --cert path/to/cert.pem --key path/to/key.pem [--port 8791]
//   (or set TC_CERT / TC_KEY / TC_PORT env vars instead of flags)
//
// No dependencies beyond Node's own https/fs/path modules.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

function argVal(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const certPath = argVal('cert', process.env.TC_CERT);
const keyPath = argVal('key', process.env.TC_KEY);
const port = parseInt(argVal('port', process.env.TC_PORT || '8791'), 10);

if (!certPath || !keyPath) {
  console.error('Missing --cert/--key (or TC_CERT/TC_KEY env vars). See the comment at the top of this file.');
  process.exit(1);
}

const root = __dirname;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png',
  '.pem': 'application/x-x509-ca-cert'
};

const server = https.createServer({
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath)
}, function (req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.normalize(path.join(root, reqPath));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, data) {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, function () {
  console.log('Training Capture serving HTTPS on port ' + port);
});
