const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = __dirname;

function git(args) {
    return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

test('local environment and private-key files are ignored while the template remains trackable', () => {
    for (const file of ['.env', '.env.local', '.env.production', '.envrc', 'deploy.pem', 'deploy.key', 'deploy.p12', 'deploy.pfx', 'deploy.jks', 'deploy.keystore']) {
        const result = git(['check-ignore', '--no-index', '-q', '--', file]);
        assert.equal(result.status, 0, `${file} should be ignored`);
    }

    assert.equal(git(['check-ignore', '-q', '--', '.env.example']).status, 1);
});

test('environment template contains placeholders, not populated credentials', () => {
    const template = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const sensitiveKeys = new Set([
        'DATABASE_URL',
        'DB_PASSWORD',
        'SESSION_SECRET',
        'ADMIN_INITIAL_PASSWORD',
        'GOOGLE_CLIENT_SECRET',
        'ZAPIER_WEBHOOK_URL',
        'EMAIL_PASSWORD'
    ]);

    for (const line of template.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!match || !sensitiveKeys.has(match[1]) || !match[2]) continue;
        assert.match(match[2], /^(?:replace-with-.+|<.*>|\$\{.*\}|.*example.*)$/i, `${match[1]} should remain a placeholder`);
    }
});

test('Render delegates the initial admin password to the deployment environment', () => {
    const renderConfig = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
    assert.match(renderConfig, /- key: ADMIN_INITIAL_PASSWORD\s+sync: false/);
});

test('public frontend files do not reference server-only environment variables', () => {
    const publicFiles = fs.readdirSync(root)
        .filter((file) => /\.html$/i.test(file) || ['crm-api.js', 'settings-ui.js'].includes(file));
    const serverOnlyReference = /process\.env(?:\.|\[['"])(?:SESSION_SECRET|DATABASE_URL|DB_PASSWORD|GOOGLE_CLIENT_SECRET|EMAIL_PASSWORD|ZAPIER_WEBHOOK_URL)\b/i;

    for (const file of publicFiles) {
        const source = fs.readFileSync(path.join(root, file), 'utf8');
        assert.equal(serverOnlyReference.test(source), false, `${file} must not reference server-only environment variables`);
    }
});

test('workflow verification refuses to run without disposable-local opt-in', () => {
    const env = { ...process.env };
    for (const key of ['CRM_VERIFY_BASE_URL', 'CRM_VERIFY_ADMIN_LOGIN_ID', 'CRM_VERIFY_ADMIN_PASSWORD', 'CRM_VERIFY_DISPOSABLE_ENVIRONMENT']) {
        delete env[key];
    }
    const result = spawnSync(process.execPath, ['verify-workflow.js'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CRM_VERIFY_DISPOSABLE_ENVIRONMENT=true/);
});

test('public pages are indexable and robots.txt does not block the site', () => {
    const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
    assert.match(robots, /Allow:\s*\//i);
    assert.doesNotMatch(robots, /Disallow:\s*\//i);

    const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
    assert.match(serverSource, /'X-Robots-Tag': 'index, follow, max-image-preview:large'/);
    assert.doesNotMatch(serverSource, /'X-Robots-Tag': 'noindex, nofollow, noarchive'/);
});
