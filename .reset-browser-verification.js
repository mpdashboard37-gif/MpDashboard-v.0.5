const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const rootDir = __dirname;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inpace-reset-browser-'));
const databasePath = path.join(tempDir, 'crm.sqlite');
const storagePath = path.join(tempDir, 'crm-files');
fs.mkdirSync(storagePath, { recursive: true });
const syntheticAccount = {
    id: 'browser-reset-user',
    loginId: 'browser-reset@test.invalid',
    password: `Initial${crypto.randomBytes(12).toString('hex')}7`
};
const smtpMessages = [];
let serverOutput = '';
let crmProcess = null;
let helperServer = null;
let smtpServer = null;
let cleanupStarted = false;
let watchdog;

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function createSmtpSink() {
    return net.createServer((socket) => {
        let buffer = '';
        let dataMode = false;
        let authLoginStep = 0;
        let messageLines = [];
        socket.setEncoding('utf8');
        socket.write('220 local-test-smtp ESMTP ready\r\n');
        socket.on('data', (chunk) => {
            buffer += chunk;
            while (buffer.includes('\r\n')) {
                const lineEnd = buffer.indexOf('\r\n');
                const line = buffer.slice(0, lineEnd);
                buffer = buffer.slice(lineEnd + 2);
                if (dataMode) {
                    if (line === '.') {
                        dataMode = false;
                        smtpMessages.push(messageLines.join('\r\n'));
                        messageLines = [];
                        socket.write('250 message accepted by local test sink\r\n');
                    } else {
                        messageLines.push(line.startsWith('..') ? line.slice(1) : line);
                    }
                    continue;
                }
                if (/^EHLO|^HELO/i.test(line)) socket.write('250-local-test-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n');
                else if (/^AUTH PLAIN/i.test(line)) socket.write('235 authentication accepted\r\n');
                else if (/^AUTH LOGIN/i.test(line)) { authLoginStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
                else if (authLoginStep === 1) { authLoginStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
                else if (authLoginStep === 2) { authLoginStep = 0; socket.write('235 authentication accepted\r\n'); }
                else if (/^(MAIL FROM|RCPT TO):/i.test(line)) socket.write('250 accepted\r\n');
                else if (/^DATA$/i.test(line)) { dataMode = true; socket.write('354 end with dot\r\n'); }
                else if (/^(RSET|NOOP)$/i.test(line)) socket.write('250 ok\r\n');
                else if (/^QUIT$/i.test(line)) socket.write('221 closing connection\r\n');
                else socket.write('250 ok\r\n');
            }
        });
    });
}

function findEmailResetToken() {
    const messages = [...smtpMessages].reverse();
    for (const message of messages) {
        const candidates = [message];
        for (const part of message.split(/--[^\r\n]+/)) {
            const separator = part.indexOf('\r\n\r\n');
            if (separator < 0) continue;
            const headers = part.slice(0, separator);
            const body = part.slice(separator + 4).trim();
            if (/content-transfer-encoding:\s*base64/i.test(headers)) {
                candidates.push(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'));
            } else if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
                candidates.push(body.replace(/=\r?\n/g, '').replace(/=([a-f0-9]{2})/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16))));
            }
        }
        for (const candidate of candidates) {
            const match = candidate.match(/login\.html#token=([a-f0-9]{64})/i);
            if (match) return match[1];
        }
    }
    return null;
}

function controllerHtml(appUrl) {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Local Reset Verification</title><body>
        <button id="open-app" type="button">Open local CRM login</button>
        <button id="open-valid" type="button">Open received reset link</button>
        <button id="open-expired" type="button">Open expired reset link</button>
        <button id="open-reused" type="button">Open reused reset link</button>
        <button id="open-invalid" type="button">Open invalid reset link</button>
        <script>
        const appUrl = ${JSON.stringify(appUrl)};
        async function openLink(kind) {
            const response = await fetch('/__test/token?kind=' + encodeURIComponent(kind), { cache: 'no-store' });
            if (!response.ok) return;
            const payload = await response.json();
            location.assign(appUrl + '/login.html#token=' + payload.token);
        }
        document.getElementById('open-app').addEventListener('click', () => location.assign(appUrl + '/login.html'));
        document.getElementById('open-valid').addEventListener('click', () => openLink('valid'));
        document.getElementById('open-expired').addEventListener('click', () => openLink('expired'));
        document.getElementById('open-reused').addEventListener('click', () => openLink('reused'));
        document.getElementById('open-invalid').addEventListener('click', () => openLink('invalid'));
        </script></body></html>`;
}

async function cleanup(exitCode = 0) {
    if (cleanupStarted) return;
    cleanupStarted = true;
    clearTimeout(watchdog);
    if (crmProcess && crmProcess.exitCode === null) {
        const exited = new Promise((resolve) => crmProcess.once('exit', resolve));
        crmProcess.kill('SIGTERM');
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2500))]);
    }
    if (helperServer?.listening) await new Promise((resolve) => helperServer.close(resolve));
    if (smtpServer?.listening) await new Promise((resolve) => smtpServer.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exitCode = exitCode;
}

async function main() {
    const crmPort = await getFreePort();
    const helperPort = await getFreePort();
    const smtpPort = await getFreePort();
    const appUrl = `http://127.0.0.1:${crmPort}`;
    const helperUrl = `http://127.0.0.1:${helperPort}`;
    const expiredToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
    const sessionSecret = crypto.randomBytes(32).toString('hex');

    smtpServer = createSmtpSink();
    await new Promise((resolve, reject) => {
        smtpServer.once('error', reject);
        smtpServer.listen(smtpPort, '127.0.0.1', resolve);
    });

    helperServer = http.createServer((request, response) => {
        const url = new URL(request.url, helperUrl);
        response.setHeader('Cache-Control', 'no-store');
        if (url.pathname === '/controller') {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(controllerHtml(appUrl));
            return;
        }
        if (url.pathname === '/__test/token') {
            const kind = url.searchParams.get('kind');
            const token = kind === 'valid' || kind === 'reused' ? findEmailResetToken()
                : kind === 'expired' ? expiredToken
                    : kind === 'invalid' ? crypto.randomBytes(32).toString('hex') : null;
            response.writeHead(token ? 200 : 404, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(token ? { token } : { error: 'not ready' }));
            return;
        }
        if (url.pathname === '/__test/token-status') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ validLinkCaptured: Boolean(findEmailResetToken()), messageCaptured: smtpMessages.length > 0 }));
            return;
        }
        if (url.pathname === '/__test/finish' && request.method === 'POST') {
            let body = '';
            request.on('data', (chunk) => { body += chunk.toString(); });
            request.on('end', () => {
                let submitted = {};
                try { submitted = JSON.parse(body); } catch (error) { }
                const validToken = findEmailResetToken();
                const mailIsSynthetic = smtpMessages.length > 0 && smtpMessages.every((message) => message.includes('browser-reset@test.invalid'));
                const report = {
                    outcome: submitted.checks?.every((item) => item.result === 'PASS') && smtpMessages.length > 0 && mailIsSynthetic && validToken && !serverOutput.includes(validToken) && !/#token=[a-f0-9]{64}/i.test(serverOutput) ? 'PASS' : 'FAIL',
                    browserChecks: submitted.checks || [],
                    localSmtpCapturedMessage: smtpMessages.length > 0,
                    recipientIsSynthetic: mailIsSynthetic,
                    emailContainsExtractableResetLink: Boolean(validToken),
                    resetTokenAbsentFromApplicationLogs: Boolean(validToken) && !serverOutput.includes(validToken) && !/#token=[a-f0-9]{64}/i.test(serverOutput),
                    appLogsDoNotContainTokenizedUrl: !/#token=|\?token=/i.test(serverOutput),
                    isolatedDatabaseAndFiles: true
                };
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(report));
                console.log(JSON.stringify(report, null, 2));
                cleanup(report.outcome === 'PASS' ? 0 : 1);
            });
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise((resolve, reject) => {
        helperServer.once('error', reject);
        helperServer.listen(helperPort, '127.0.0.1', resolve);
    });

    const childSource = `const config = require('./database/config.js'); config.sqlitePath = ${JSON.stringify(databasePath)}; require('./server.js');`;
    crmProcess = spawn(process.execPath, ['-e', childSource], {
        cwd: rootDir,
        env: {
            ...process.env,
            NODE_ENV: 'test', DATABASE_MODE: 'sqlite', DATABASE_URL: '', DB_HOST: '', DB_PORT: '', DB_USER: '', DB_PASSWORD: '', DB_NAME: '',
            PORT: String(crmPort), SESSION_SECRET: sessionSecret, ADMIN_INITIAL_PASSWORD: crypto.randomBytes(24).toString('base64url'),
            CORS_ORIGIN: appUrl, CRM_FILE_STORAGE_ROOT: storagePath,
            PASSWORD_RESET_BASE_URL: `${appUrl}/login.html`,
            EMAIL_HOST: '127.0.0.1', EMAIL_PORT: String(smtpPort), EMAIL_SECURE: 'false',
            EMAIL_USER: 'synthetic-smtp-user', EMAIL_PASSWORD: 'synthetic-smtp-password', EMAIL_FROM: 'crm-test@invalid.test'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const capture = (chunk) => { serverOutput = `${serverOutput}${chunk.toString()}`.slice(-10000); };
    crmProcess.stdout.on('data', capture);
    crmProcess.stderr.on('data', capture);
    crmProcess.once('error', (error) => {
        console.error(JSON.stringify({ outcome: 'NOT TESTED', reason: `Unable to start disposable CRM process (${error.code || 'spawn error'}).` }));
        cleanup(1);
    });

    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && crmProcess.exitCode === null) {
        try {
            const response = await fetch(`${appUrl}/api/auth/me`, { signal: AbortSignal.timeout(1000) });
            if (response.status === 401) { ready = true; break; }
        } catch (error) { }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('Disposable CRM did not become ready.');

    const database = new DatabaseSync(databasePath);
    database.prepare('INSERT INTO staff (id, employee_id, name, email, department, designation, login_id, password_hash, role, status, account_status, failed_login_attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
        .run(syntheticAccount.id, 'BROWSER-RESET-TEST', 'Browser Reset Test', syntheticAccount.loginId, 'Sales', 'Sales Executive', syntheticAccount.loginId, hashPassword(syntheticAccount.password), 'Sales Executive', 'Active', 'ACTIVE', new Date().toISOString());
    database.prepare('INSERT INTO password_reset_tokens (token_hash, staff_id, expires_at) VALUES (?, ?, ?)')
        .run(tokenHash(expiredToken), syntheticAccount.id, new Date(Date.now() - 60000).toISOString());
    database.close();

    console.log(`RESET_BROWSER_TEST_READY ${helperUrl}/controller`);
    watchdog = setTimeout(() => {
        console.error(JSON.stringify({ outcome: 'NOT TESTED', reason: 'Browser verification exceeded its 180-second limit.' }));
        cleanup(1);
    }, 180000);
}

process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));
main().catch((error) => {
    console.error(JSON.stringify({ outcome: 'NOT TESTED', reason: error.message }));
    cleanup(1);
});