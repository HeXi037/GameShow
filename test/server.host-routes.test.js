const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'development';
const { server, __testHooks } = require('../server');

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

async function hostPost(path, payload) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload)
  });
}

test('resume existing session route restores room state', async () => {
  await hostPost('/host/setup', { roomCode: 'ROOMX', playerNames: 'A,B', localDataFile: 'sample-game.json' });
  const archiveRes = await hostPost('/host/archive', { roomCode: 'ROOMX' });
  assert.equal(archiveRes.status, 200);

  const resumeRes = await hostPost('/host/resume', { roomCode: 'ROOMX' });
  assert.equal(resumeRes.status, 200);
  const room = __testHooks.getOrCreateRoom('ROOMX');
  assert.equal(room.gameState.quickMoney.topFinalists, 2);
  assert.ok(room.gameState.config);
});
