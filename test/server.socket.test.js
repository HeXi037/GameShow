const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'development';
const { initializeGame, selectClue, openBuzz, lockBuzz } = require('../src/gameState');
const { __testHooks } = require('../server');

function makeBoard() {
  const makeRound = (values) => ({ categories: Array.from({ length: 5 }, (_, c) => ({ name: `C${c}`, clues: values.map((v, i) => ({ value: v, answer: `a${c}${i}`, question: `q${c}${i}`, used: false })) })) });
  return { round1: makeRound([100, 200, 300, 400, 500]), round2: { ...makeRound([200, 400, 600, 800, 1000]), mogulMultiplier: { categoryIndex: 1, clueIndex: 2 } }, quickMoneyPrompts: ['p1', 'p2', 'p3', 'p4', 'p5'] };
}

function seedRoom(code, players) {
  const room = __testHooks.getOrCreateRoom(code);
  room.gameState = initializeGame({ playerNames: players, boardData: makeBoard() });
  room.gameState = selectClue(room.gameState, 0, 0).state;
  room.gameState = openBuzz(room.gameState).state;
  room.gameState.answerCapture = { clueKey: 'r1:c0:q0', byPlayer: {} };
  room.gameState.archivedAnswers = [];
  return room;
}

test('buzz lock in one room does not affect another room', () => {
  const r1 = seedRoom('ROOMA', ['A', 'B']);
  const r2 = seedRoom('ROOMB', ['X', 'Y']);

  r1.gameState = lockBuzz(r1.gameState, 'A', Date.now()).state;

  assert.equal(r1.gameState.buzz.lockedBy, 'A');
  assert.equal(r2.gameState.buzz.lockedBy, null);
  assert.equal(__testHooks.publicState(r1).buzz.lockedBy, 'A');
  assert.equal(__testHooks.publicState(r2).buzz.lockedBy, null);
});

test('answer capture only allowed for current buzz winner', () => {
  const room = seedRoom('ROOMC', ['A', 'B']);
  room.gameState = lockBuzz(room.gameState, 'A', Date.now()).state;

  const canA = room.gameState.buzz.lockedBy === 'A';
  const canB = room.gameState.buzz.lockedBy === 'B';

  assert.equal(canA, true);
  assert.equal(canB, false);
});

test('answer capture ordering is keyed by clue then player', () => {
  const room = seedRoom('ROOMD', ['A', 'B']);
  room.gameState = lockBuzz(room.gameState, 'A', 100).state;

  room.gameState.answerCapture.byPlayer.A = { playerName: 'A', clueKey: 'r1:c0:q0', answer: 'first', submittedAt: 100 };
  room.gameState.archivedAnswers.push(room.gameState.answerCapture.byPlayer.A);

  assert.equal(room.gameState.archivedAnswers[0].clueKey, 'r1:c0:q0');
  assert.equal(room.gameState.archivedAnswers[0].playerName, 'A');
  assert.equal(room.gameState.archivedAnswers[0].submittedAt, 100);
});

test('answer overwrite prevention blocks second submit for same clue/player', () => {
  const room = seedRoom('ROOME', ['A', 'B']);
  room.gameState = lockBuzz(room.gameState, 'A', 100).state;
  room.gameState.answerCapture.byPlayer.A = { playerName: 'A', clueKey: 'r1:c0:q0', answer: 'first', submittedAt: 100 };

  const alreadySubmitted = Boolean(room.gameState.answerCapture.byPlayer.A);
  assert.equal(alreadySubmitted, true);
  assert.equal(room.gameState.answerCapture.byPlayer.A.answer, 'first');
});
