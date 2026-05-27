const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'development';
const { server, __testHooks } = require('../server');
const { saveSession } = require('../src/sessionStore');

let baseUrl;
let cookie;

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
  await new Promise((resolve) => server.close(resolve));
});


async function hostSetup(fields) {
  const body = new URLSearchParams();
  Object.entries(fields).forEach(([key, value]) => body.set(key, String(value)));
  return fetch(`${baseUrl}/host/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: body.toString(),
    redirect: 'manual'
  });
}

async function hostPost(path, payload) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload)
  });
}

test('resume existing session route restores persisted topFinalists state', async () => {
  saveSession('ROOMX', {
    roomCode: 'ROOMX',
    quickMoney: { topFinalists: 4 },
    config: { reopenOnIncorrect: true }
  });

  const archiveRes = await hostPost('/host/archive', { roomCode: 'ROOMX' });
  assert.equal(archiveRes.status, 200);

  const resumeRes = await hostPost('/host/resume', { roomCode: 'ROOMX' });
  assert.equal(resumeRes.status, 200);
  const room = __testHooks.getOrCreateRoom('ROOMX');
  assert.equal(room.gameState.quickMoney.topFinalists, 4);
  assert.ok(room.gameState.config);
});


test('setup route validates topFinalists bounds', async () => {
  const tooLow = await hostSetup({ roomCode: 'LOW1', playerNames: 'A,B', localDataFile: 'sample-game.json', topFinalists: 1 });
  assert.equal(tooLow.status, 400);

  const tooHigh = await hostSetup({ roomCode: 'HIGH1', playerNames: 'A,B', localDataFile: 'sample-game.json', topFinalists: 6 });
  assert.equal(tooHigh.status, 400);

  const nonInteger = await hostSetup({ roomCode: 'BAD1', playerNames: 'A,B', localDataFile: 'sample-game.json', topFinalists: 'abc' });
  assert.equal(nonInteger.status, 400);
});


test('export route returns JSON and CSV with correct headers', async () => {
  saveSession('EXR1', { phase: 'round1', players: [{ name: 'A', score: 100 }] });
  await hostPost('/host/resume', { roomCode: 'EXR1' });

  const jsonRes = await fetch(`${baseUrl}/host/export/EXR1`, { headers: { Cookie: cookie } });
  assert.equal(jsonRes.status, 200);
  assert.match(jsonRes.headers.get('content-type') || '', /application\/json/);
  assert.match(jsonRes.headers.get('content-disposition') || '', /attachment; filename="EXR1-\d{4}-\d{2}-\d{2}\.json"/);
  const payload = await jsonRes.json();
  assert.equal(payload.roomCode, 'EXR1');
  assert.ok(Array.isArray(payload.scores));

  const csvRes = await fetch(`${baseUrl}/host/export/EXR1?format=csv`, { headers: { Cookie: cookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
  assert.match(csvRes.headers.get('content-disposition') || '', /attachment; filename="EXR1-\d{4}-\d{2}-\d{2}\.csv"/);
  const csvText = await csvRes.text();
  assert.match(csvText, /section,roomCode,phase/);
});

test('export route enforces 403 for wrong host context and 404 for missing session', async () => {
  saveSession('EXR2', { phase: 'round1', players: [{ name: 'A', score: 10 }] });
  await hostPost('/host/resume', { roomCode: 'EXR2' });

  const forbiddenRes = await fetch(`${baseUrl}/host/export/OTHER1`, { headers: { Cookie: cookie } });
  assert.equal(forbiddenRes.status, 403);

  const sessionFile = path.join(__dirname, '..', 'data', 'sessions', 'EXR2.json');
  fs.rmSync(sessionFile, { force: true });
  const missingRes = await fetch(`${baseUrl}/host/export/EXR2`, { headers: { Cookie: cookie } });
  assert.equal(missingRes.status, 404);
});

test('upload media route validates auth, type, and size', async () => {
  const goodBlob = new Blob([Buffer.from('fakepng')], { type: 'image/png' });
  const goodForm = new FormData();
  goodForm.set('media', goodBlob, 'my file.png');
  const goodRes = await fetch(`${baseUrl}/host/upload-media`, { method: 'POST', headers: { Cookie: cookie }, body: goodForm });
  assert.equal(goodRes.status, 201);
  const goodPayload = await goodRes.json();
  assert.equal(goodPayload.ok, true);
  assert.match(goodPayload.media.url, /^\/media\//);

  const badTypeForm = new FormData();
  badTypeForm.set('media', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'bad.txt');
  const badTypeRes = await fetch(`${baseUrl}/host/upload-media`, { method: 'POST', headers: { Cookie: cookie }, body: badTypeForm });
  assert.equal(badTypeRes.status, 400);

  const huge = new Uint8Array((10 * 1024 * 1024) + 1);
  const bigForm = new FormData();
  bigForm.set('media', new Blob([huge], { type: 'image/jpeg' }), 'big.jpg');
  const bigRes = await fetch(`${baseUrl}/host/upload-media`, { method: 'POST', headers: { Cookie: cookie }, body: bigForm });
  assert.equal(bigRes.status, 400);
});


test('route views include required accessibility roles and labels', async () => {
  const playerRes = await fetch(`${baseUrl}/join?room=ROOM1&code=ABC123`);
  assert.equal(playerRes.status, 200);
  const playerHtml = await playerRes.text();
  assert.match(playerHtml, /aria-label=["']Buzz in["']/);

  const hostRes = await fetch(`${baseUrl}/host`, { headers: { Cookie: cookie } });
  assert.equal(hostRes.status, 200);
  const hostHtml = await hostRes.text();
  assert.match(hostHtml, /id="hostReveal" aria-live="polite"/);
  assert.match(hostHtml, /id="quickMoneyStatus" aria-live="polite"/);
});
