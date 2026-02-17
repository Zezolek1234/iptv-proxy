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

    // ─── Playlist Endpoint (fetches M3U server-side, never exposes URL) ───
    if (pathname === '/api/playlist') {
        const m3uUrl = process.env.M3U_URL;
        if (!m3uUrl) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('No M3U_URL configured');
        }
        console.log('[PLAYLIST] Fetching M3U server-side');
        fetchUrl(m3uUrl, (err, data) => {
            if (err) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                return res.end('Failed to fetch playlist');
            }
            // Parse stream hosts from M3U to build allowed domains list
            updateAllowedDomains(data);
            res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
            res.end(data);
        });
        return;
    }

    // ─── EPG Endpoint (fetches EPG XML server-side, never exposes URL) ───
    if (pathname === '/api/epg') {
        const epgUrl = process.env.EPG_URL || 'https://epg.ovh/pl.xml';
        console.log('[EPG] Fetching EPG server-side');
        fetchUrl(epgUrl, (err, data) => {
            if (err) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                return res.end('Failed to fetch EPG');
            }
            res.writeHead(200, { 'Content-Type': 'application/xml' });
            res.end(data);
        });
        return;
    }

    // ─── Proxy Endpoint (RESTRICTED to known stream domains only) ───
    if (pathname === '/api/proxy') {
        const targetUrl = parsedUrl.query.url;

        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Missing ?url= parameter');
        }

        // Security: only allow proxying to known stream domains
        try {
            const targetHost = new URL(targetUrl).hostname;
            if (!isAllowedDomain(targetHost)) {
                console.warn(`[PROXY] Blocked: ${targetHost}`);
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                return res.end('Domain not allowed');
            }
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            return res.end('Invalid URL');
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
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
    };

    if (proxyRes.headers['content-type']) {
        headers['Content-Type'] = proxyRes.headers['content-type'];
    }
    if (proxyRes.headers['content-length']) {
        headers['Content-Length'] = proxyRes.headers['content-length'];
    }

    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes);
}

// ─── Helper: fetch URL and return data ───
function fetchUrl(targetUrl, callback) {
    const fetcher = targetUrl.startsWith('https') ? https : http;
    const chunks = [];

    fetcher.get(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (IPTV Player Proxy)', 'Accept': '*/*' },
        timeout: 30000,
    }, (response) => {
        // Follow one redirect
        if ([301, 302, 307, 308].includes(response.statusCode) && response.headers.location) {
            return fetchUrl(response.headers.location, callback);
        }
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks).toString('utf-8')));
        response.on('error', err => callback(err));
    }).on('error', err => callback(err));
}

// ─── Allowed domains (auto-populated from M3U) ───
let allowedDomains = new Set();

function updateAllowedDomains(m3uContent) {
    const lines = m3uContent.split('\n');
    const newDomains = new Set();
    lines.forEach(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            try {
                const host = new URL(line).hostname;
                newDomains.add(host);
            } catch (e) { /* skip invalid URLs */ }
        }
    });
    allowedDomains = newDomains;
    console.log(`[SECURITY] Allowed ${allowedDomains.size} stream domains`);
}

function isAllowedDomain(hostname) {
    // Check exact match or subdomain match
    for (const domain of allowedDomains) {
        if (hostname === domain || hostname.endsWith('.' + domain)) {
            return true;
        }
    }
    return false;
}

server.listen(PORT, () => {
    console.log(`\n🚀  IPTV Player Server działa!`);
    console.log(`    Otwórz: http://localhost:${PORT}\n`);
});
