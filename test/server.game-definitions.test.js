const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'development';
const { server } = require('../server');

let baseUrl;
let cookie;
const dataDir = path.join(__dirname, '..', 'data');

async function hostRequest(url, options = {}) {
  const res = await fetch(`${baseUrl}${url}`, { ...options, headers: { ...(options.headers || {}), Cookie: cookie } });
  return res;
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginRes = await fetch(`${baseUrl}/host/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'password=mogulhost', redirect: 'manual'
  });
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  ['test-valid-game.json', 'unsafe_name.json'].forEach((f) => {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  await new Promise((resolve) => server.close(resolve));
});

function sampleData() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'sample-game.json'), 'utf8'));
}

test('saves a valid game definition', async () => {
  const res = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-valid-game', data: sampleData() })
  });
  assert.equal(res.status, 201);
  assert.equal(fs.existsSync(path.join(dataDir, 'test-valid-game.json')), true);
});

test('rejects invalid schema', async () => {
  const bad = sampleData();
  bad.round1.categories = bad.round1.categories.slice(0, 4);
  const res = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'invalid-game', data: bad })
  });
  assert.equal(res.status, 400);
});

test('rejects unsafe filename', async () => {
  const res = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../unsafe_name', data: sampleData() })
  });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(path.join(dataDir, 'unsafe_name.json')), false);
});
