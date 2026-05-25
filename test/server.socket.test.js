const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'development';
const { initializeGame, selectClue, openBuzz, lockBuzz } = require('../src/gameState');
const { __testHooks } = require('../server');

function makeBoard() {
  const makeRound = (values) => ({ categories: Array.from({ length: 5 }, (_, c) => ({ name: `C${c}`, clues: values.map((v, i) => ({ value: v, answer: `a${c}${i}`, question: `q${c}${i}`, used: false })) })) });
  return { round1: makeRound([100, 200, 300, 400, 500]), round2: { ...makeRound([200, 400, 600, 800, 1000]), mogulMultiplier: { categoryIndex: 1, clueIndex: 2 } }, quickMoneyPrompts: ['p1','p2','p3','p4','p5'] };
}

function seedRoom(code, players) {
  const room = __testHooks.getOrCreateRoom(code);
  room.gameState = initializeGame({ playerNames: players, boardData: makeBoard() });
  room.gameState = selectClue(room.gameState, 0, 0).state;
  room.gameState = openBuzz(room.gameState).state;
  return room;
}

test('buzz lock in one room does not affect another room', () => {
  const r1 = seedRoom('ROOMA', ['A','B']);
  const r2 = seedRoom('ROOMB', ['X','Y']);

  r1.gameState = lockBuzz(r1.gameState, 'A', Date.now()).state;

  assert.equal(r1.gameState.buzz.lockedBy, 'A');
  assert.equal(r2.gameState.buzz.lockedBy, null);
  assert.equal(__testHooks.publicState(r1).buzz.lockedBy, 'A');
  assert.equal(__testHooks.publicState(r2).buzz.lockedBy, null);
});
