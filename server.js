/**
 * IPTV Player — Local Proxy Server
 * 
 * Uruchom: node server.js
 * Otwórz:  http://localhost:3000
 * 
 * Serwuje pliki statyczne oraz udostępnia endpoint /api/proxy?url=...
 * który pobiera zasoby z zewnętrznych serwerów (omijając CORS).
 * 
 * Zero zależności — działa na czystym Node.js.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// ─── Load .env file (no dependencies) ───
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
    try {
        const content = fs.readFileSync(envPath, 'utf-8');
        content.split('\n').forEach(line => {
            line = line.trim();
            if (!line || line.startsWith('#')) return;
            const eqIndex = line.indexOf('=');
            if (eqIndex === -1) return;
            const key = line.substring(0, eqIndex).trim();
            const value = line.substring(eqIndex + 1).trim();
            if (!process.env[key]) { // Don't override existing env vars (e.g. from Render)
                process.env[key] = value;
            }
        });
        console.log('[ENV] Loaded .env file');
    } catch (e) {
        console.log('[ENV] No .env file found, using environment variables');
    }
}
loadEnv();

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // ─── Config Endpoint (serves URLs from .env) ───
    if (pathname === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            m3uUrl: process.env.M3U_URL || '',
            epgUrl: process.env.EPG_URL || 'https://epg.ovh/pl.xml',
        }));
    }

    // ─── Proxy Endpoint ───
    if (pathname === '/api/proxy') {
        const targetUrl = parsedUrl.query.url;

        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing ?url= parameter');
        }

        console.log(`[PROXY] ${targetUrl}`);

        const fetcher = targetUrl.startsWith('https') ? https : http;

        const proxyReq = fetcher.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (IPTV Player Proxy)',
                'Accept': '*/*',
            },
            timeout: 30000,
        }, (proxyRes) => {
            // Follow redirects (301, 302, 307, 308)
            if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                const redirectUrl = proxyRes.headers.location;
                console.log(`[PROXY] Redirect -> ${redirectUrl}`);
                // Re-fetch with the redirect URL
                const redirectFetcher = redirectUrl.startsWith('https') ? https : http;
                redirectFetcher.get(redirectUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (IPTV Player Proxy)',
                        'Accept': '*/*',
                    },
                    timeout: 30000,
                }, (redirectRes) => {
                    sendProxyResponse(res, redirectRes);
                }).on('error', (err) => {
                    console.error('[PROXY] Redirect error:', err.message);
                    res.writeHead(502, { 'Content-Type': 'text/plain' });
                    res.end('Proxy redirect error: ' + err.message);
                });
                return;
            }

            sendProxyResponse(res, proxyRes);
        });

        proxyReq.on('error', (err) => {
            console.error('[PROXY] Error:', err.message);
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Proxy error: ' + err.message);
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            res.writeHead(504, { 'Content-Type': 'text/plain' });
            res.end('Proxy timeout');
        });

        return;
    }

    // ─── Static File Server ───
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);

    // Basic security: prevent path traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not found: ' + pathname);
            } else {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server error');
            }
            return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

function sendProxyResponse(clientRes, proxyRes) {
    // Forward status and important headers, add CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
    };

    // Forward content-type if present
    if (proxyRes.headers['content-type']) {
        headers['Content-Type'] = proxyRes.headers['content-type'];
    }
    if (proxyRes.headers['content-length']) {
        headers['Content-Length'] = proxyRes.headers['content-length'];
    }

    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes);
}

server.listen(PORT, () => {
    console.log(`\n🚀  IPTV Player Server działa!`);
    console.log(`    Otwórz: http://localhost:${PORT}\n`);
});
