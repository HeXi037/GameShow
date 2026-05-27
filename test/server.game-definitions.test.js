const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'development';
const { server } = require('../server');

let baseUrl;
let cookie;
const dataDir = path.join(__dirname, '..', 'data');
const createdFiles = ['test-valid-game.json', 'test-duplicate-game.json'];

async function hostRequest(url, options = {}) {
  return fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { ...(options.headers || {}), Cookie: cookie }
  });
}

function sampleData() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'sample-game.json'), 'utf8'));
}

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginRes = await fetch(`${baseUrl}/host/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=mogulhost',
    redirect: 'manual'
  });
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  createdFiles.forEach((f) => {
    const filePath = path.join(dataDir, f);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });
  await new Promise((resolve) => server.close(resolve));
});

test('create definition and load by name', async () => {
  const createRes = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-valid-game', data: sampleData() })
  });
  assert.equal(createRes.status, 201);
  assert.equal(fs.existsSync(path.join(dataDir, 'test-valid-game.json')), true);

  const loadRes = await hostRequest('/host/game-definitions/test-valid-game');
  assert.equal(loadRes.status, 200);
  const payload = await loadRes.json();
  assert.equal(payload.name, 'test-valid-game');
  assert.equal(Array.isArray(payload.data.round1.categories), true);
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

test('rejects duplicate definition name', async () => {
  const data = sampleData();
  const first = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-duplicate-game', data })
  });
  assert.equal(first.status, 201);

  const second = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-duplicate-game', data })
  });
  assert.equal(second.status, 409);
});

test('rejects bad names and path traversal', async () => {
  const badNameRes = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../unsafe_name', data: sampleData() })
  });
  assert.equal(badNameRes.status, 400);

  const loadTraversalRes = await hostRequest('/host/game-definitions/../sample-game');
  assert.equal(loadTraversalRes.status, 404);

  const encodedTraversalRes = await hostRequest('/host/game-definitions/%2e%2e%2fsample-game');
  assert.equal(encodedTraversalRes.status, 400);
});

test('accepts valid clue media and rejects malformed media schema', async () => {
  const withMedia = sampleData();
  withMedia.round1.categories[0].clues[0].media = {
    type: 'image',
    url: '/media/example.png',
    altText: 'Example alt',
    caption: 'Example caption'
  };
  const okRes = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-media-valid', data: withMedia })
  });
  assert.equal(okRes.status, 201);
  createdFiles.push('test-media-valid.json');

  const bad = sampleData();
  bad.round1.categories[0].clues[0].media = { type: 'gif', url: '' };
  const badRes = await hostRequest('/host/game-definitions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'test-media-invalid', data: bad })
  });
  assert.equal(badRes.status, 400);
});
