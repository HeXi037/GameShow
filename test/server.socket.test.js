const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'development';
const { initializeGame, selectClue, openBuzz, resetBuzz, applyScoreAndBuzzRules, updateConfig } = require('../src/gameState');
const { attemptBuzz } = require('../server');

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

function mkSocket() {
  const emitted = [];
  return {
    emitted,
    emit: (event, payload) => emitted.push({ event, payload }),
    broadcast: { emit: (event, payload) => emitted.push({ event: `broadcast:${event}`, payload }) }
  };
}

function mkIo() {
  const emitted = [];
  return { emitted, emit: (event, payload) => emitted.push({ event, payload }) };
}

function mkState() {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = selectClue(state, 0, 0).state;
  state = openBuzz(state).state;
  return state;
}

test('first buzz wins; subsequent buzzes rejected while locked', () => {
  let state = mkState();
  const io = mkIo();
  const firstSocket = mkSocket();
  const secondSocket = mkSocket();

  attemptBuzz({ socket: firstSocket, client: { role: 'player', playerName: 'A' }, attemptedName: 'A', ioRef: io, getState: () => state, setState: (next) => { state = next; }, clearLockTimer: () => {} });
  assert.equal(state.buzz.lockedBy, 'A');
  assert.equal(io.emitted.find((e) => e.event === 'buzz:locked').payload.playerName, 'A');
  assert.equal(firstSocket.emitted.find((e) => e.event === 'broadcast:buzz:rejected').payload.reason, 'already-locked');

  attemptBuzz({ socket: secondSocket, client: { role: 'player', playerName: 'B' }, attemptedName: 'B', ioRef: io, getState: () => state, setState: (next) => { state = next; }, clearLockTimer: () => {} });
  assert.equal(secondSocket.emitted[0].event, 'buzz:rejected');
  assert.equal(secondSocket.emitted[0].payload.reason, 'buzz-closed');
});

test('reset/open behavior and reopen-after-incorrect behavior', () => {
  let state = mkState();
  const io = mkIo();
  const socket = mkSocket();

  attemptBuzz({ socket, client: { role: 'player', playerName: 'A' }, attemptedName: 'A', ioRef: io, getState: () => state, setState: (next) => { state = next; }, clearLockTimer: () => {} });
  state = resetBuzz(state).state;
  state = openBuzz(state).state;

  const bSocket = mkSocket();
  attemptBuzz({ socket: bSocket, client: { role: 'player', playerName: 'B' }, attemptedName: 'B', ioRef: io, getState: () => state, setState: (next) => { state = next; }, clearLockTimer: () => {} });
  assert.equal(state.buzz.lockedBy, 'B');

  state = updateConfig(state, { reopenOnIncorrect: true, maxAttemptsPerClue: 'unlimited' });
  state = applyScoreAndBuzzRules(state, { B: 'incorrect' }).state;
  assert.equal(state.buzz.open, true);
  assert.equal(state.buzz.lockedBy, null);
});

test('disconnect/reconnect edge semantics around active buzz windows via state rules', () => {
  const state = mkState();
  assert.equal(state.buzz.open, true);
  assert.equal(state.buzz.lockedBy, null);

  const locked = applyScoreAndBuzzRules({ ...state, buzz: { ...state.buzz, open: false, lockedBy: 'A', lockedAt: 123, attempts: [{ playerName: 'A', at: 123 }] } }, { A: 'skip' });
  assert.equal(locked.state.revealedClue, null);
  assert.equal(locked.state.buzz, null);
});
