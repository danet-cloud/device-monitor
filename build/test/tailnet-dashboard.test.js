'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startHub } = require('../../server');

const origin = 'https://edgewatch.example.ts.net:8448';
const proxy = {
  Host: new URL(origin).host,
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '100.80.90.10',
  'Tailscale-User-Login': 'owner@example.invalid',
};

async function fixture(t, enabled = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-tailnet-test-'));
  let hub = await startHub({ port: 0, dataDir: dir, fixture: true, publicUrl: origin, tailnetDashboard: enabled });
  t.after(() => { hub.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  function request(resource, headers = proxy, method = 'GET', body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: hub.port, path: resource, method,
        headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  return { request, get hub() { return hub; }, async restart() {
    hub.close();
    hub = await startHub({ port: 0, dataDir: dir, fixture: true, publicUrl: origin, tailnetDashboard: enabled });
  } };
}

test('Tailscale dashboard access is opt-in and leaves normal deployments locked', async t => {
  const { request } = await fixture(t, false);
  assert.equal((await request('/api/devices')).status, 401);
  assert.equal(JSON.parse((await request('/api/info')).text).locked, true);
});

test('trusted Serve access needs no token, stored browser data, time renewal or hub session', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/devices')).status, 200);
  assert.equal(JSON.parse((await f.request('/api/info')).text).tailnetDashboard, true);
  const html = await f.request('/');
  assert.equal(html.status, 200);
  assert.match(html.text, /data-tailnet-dashboard="true"/);
  assert.match(html.text, /!nativeDashboard && !tailnetDashboard && !sessionStorage/);
  assert.match(html.text, /signOut.hidden = nativeDashboard \|\| tailnetDashboard/);
  const oldLink = await f.request('/unlock');
  assert.equal(oldLink.status, 302);
  assert.equal(oldLink.headers.location, '/');
  const now = Date.now();
  const clock = t.mock.method(Date, 'now', () => now + 365 * 24 * 60 * 60 * 1000);
  assert.equal((await f.request('/api/devices')).status, 200);
  clock.mock.restore();
  await f.restart();
  assert.equal((await f.request('/api/devices')).status, 200);
  assert.equal((await f.request('/api/alerts')).status, 200);
});

test('Serve access rejects missing identity, LAN/public peers, Funnel and wrong origins', async t => {
  const { request } = await fixture(t);
  const cases = [
    { 'Tailscale-User-Login': '' },
    { 'X-Forwarded-Proto': 'http' },
    { 'X-Forwarded-For': '192.168.1.10' },
    { 'X-Forwarded-For': '8.8.8.8' },
    { 'X-Forwarded-For': '100.80.90.10, 127.0.0.1' },
    { 'X-Forwarded-For': '127.0.0.1' },
    { 'X-Forwarded-For': 'fd00::1234' },
    { 'Tailscale-Funnel-Request': 'true' },
    { Host: new URL(origin).hostname },
  ];
  for (const changed of cases) {
    const response = await request('/api/devices', { ...proxy, ...changed });
    assert.ok([401, 403, 421].includes(response.status), JSON.stringify(changed) + ': ' + response.status);
  }
  assert.equal((await request('/api/devices', {})).status, 401);
  const ipv6 = { ...proxy, 'X-Forwarded-For': 'fd7a:115c:a1e0::1234' };
  assert.equal((await request('/api/devices', ipv6)).status, 200);
});

test('Tailscale browser access does not enrol agents or become the local operator', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/report', proxy, 'POST', { id: 'forged' })).status, 401);
  assert.equal((await request('/api/sessions/revoke', proxy, 'POST')).status, 403);
  assert.equal((await request('/api/invites', proxy, 'POST', { kind: 'agent', origin })).status, 403);
  assert.equal((await request('/api/logout', { ...proxy, Origin: 'https://example.invalid' }, 'POST')).status, 403);
});

test('trusted dashboard event stream opens without a browser credential', async t => {
  const f = await fixture(t);
  await new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: f.hub.port, path: '/api/stream', headers: proxy }, res => {
      try { assert.equal(res.statusCode, 200); } catch (error) { res.destroy(); return reject(error); }
      res.once('data', chunk => {
        try { assert.match(chunk.toString(), /data: \{"type":"snapshot"/); resolve(); } catch (error) { reject(error); }
        res.destroy(); req.destroy();
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('Event stream did not open')));
  });
});
