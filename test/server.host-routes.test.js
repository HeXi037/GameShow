const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'development';
const { server, __testHooks } = require('../server');
const { initializeGame, selectClue } = require('../src/gameState');

function makeBoard() {
  const makeRound = (values) => ({
    categories: Array.from({ length: 5 }, (_, c) => ({
      name: `C${c}`,
      clues: values.map((v, i) => ({ value: v, answer: `a${c}${i}`, question: `q${c}${i}`, used: false }))
    }))
  });
  return {
    round1: makeRound([100, 200, 300, 400, 500]),
    round2: { ...makeRound([200, 400, 600, 800, 1000]), mogulMultiplier: { categoryIndex: 1, clueIndex: 2 } },
    quickMoneyPrompts: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
}

let baseUrl;
let cookie;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  const loginRes = await fetch(`${baseUrl}/host/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'password=mogulhost',
    redirect: 'manual'
  });
  cookie = loginRes.headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  __testHooks.buzzTimeoutInterval.unref();
  await new Promise((resolve) => server.close(resolve));
});

async function hostPost(path, payload) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(payload)
  });
}

test('host endpoints return JSON error shape for common failures', async () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  __testHooks.setGameState(state);

  const selectClueRes = await hostPost('/host/select-clue', { categoryIndex: 99, clueIndex: 0 });
  assert.equal(selectClueRes.status, 404);
  assert.deepEqual(await selectClueRes.json(), {
    error: { code: 'CLUE_NOT_FOUND', message: 'Clue not found.' }
  });

  state = selectClue(state, 0, 0).state;
  __testHooks.setGameState(state);

  const scoreRes = await hostPost('/host/score-clue', { playerResults: { A: 'correct' } });
  assert.equal(scoreRes.status, 400);
  assert.deepEqual(await scoreRes.json(), {
    error: { code: 'BUZZ_NOT_LOCKED', message: 'Select a buzz winner before scoring this clue.' }
  });

  const multiplierRes = await hostPost('/host/mogul-multiplier', { playerName: 'A', wager: 100, correct: true });
  assert.equal(multiplierRes.status, 400);
  const multiplierBody = await multiplierRes.json();
  assert.equal(multiplierBody.error.code, 'MULTIPLIER_INACTIVE');
  assert.equal(typeof multiplierBody.error.message, 'string');

  const quickSubmitRes = await hostPost('/host/quick-money/submit', { playerName: 'A', promptIndex: 0, answer: 'x', points: 10 });
  assert.equal(quickSubmitRes.status, 400);
  assert.deepEqual(await quickSubmitRes.json(), {
    error: { code: 'QUICK_MONEY_INACTIVE', message: 'Quick Money is not active.' }
  });
});
