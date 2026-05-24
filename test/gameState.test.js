const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeGame,
  selectClue,
  scoreClue,
  applyMultiplier,
  advanceQuickMoney
} = require('../src/gameState');

function makeBoard() {
  const mkRound = (values) => ({
    categories: Array.from({ length: 5 }, (_, c) => ({
      name: `Cat${c}`,
      clues: values.map((value, i) => ({ value, answer: `A${c}${i}`, question: `Q${c}${i}`, used: false }))
    }))
  });

  return {
    round1: mkRound([100, 200, 300, 400, 500]),
    round2: {
      ...mkRound([200, 400, 600, 800, 1000]),
      mogulMultiplier: { categoryIndex: 0, clueIndex: 0 }
    },
    quickMoneyPrompts: ['p1', 'p2', 'p3', 'p4', 'p5']
  };
}

function setup(players = ['A', 'B', 'C']) {
  return initializeGame({ playerNames: players, boardData: makeBoard() });
}

test('variable-player score updates (+/-/skip)', () => {
  const state = setup();
  selectClue(state, { categoryIndex: 0, clueIndex: 0 });
  scoreClue(state, {
    playerResults: { A: 'correct', B: 'incorrect', C: 'skip' }
  });

  const byName = Object.fromEntries(state.players.map((p) => [p.name, p.score]));
  assert.equal(byName.A, 100);
  assert.equal(byName.B, -100);
  assert.equal(byName.C, 0);
});

test('used-clue lockout', () => {
  const state = setup();
  assert.equal(selectClue(state, { categoryIndex: 0, clueIndex: 1 }).ok, true);
  const second = selectClue(state, { categoryIndex: 0, clueIndex: 1 });
  assert.equal(second.ok, false);
  assert.match(second.error, /already used/i);
});

test('round 1 -> round 2 transition', () => {
  const state = setup();
  for (let c = 0; c < 5; c += 1) {
    for (let i = 0; i < 5; i += 1) {
      selectClue(state, { categoryIndex: c, clueIndex: i });
      scoreClue(state, { playerResults: {} });
    }
  }
  assert.equal(state.round, 2);
  assert.equal(state.phase, 'round2');
});

test('round 2 completion -> Quick Money finalists selection', () => {
  const state = setup();
  state.round = 2;
  state.phase = 'round2';
  state.players = [
    { name: 'A', score: 500 },
    { name: 'B', score: 300 },
    { name: 'C', score: 100 }
  ];

  for (let c = 0; c < 5; c += 1) {
    for (let i = 0; i < 5; i += 1) {
      selectClue(state, { categoryIndex: c, clueIndex: i });
      if (state.revealedClue.isMogulMultiplier) {
        applyMultiplier(state, { playerName: 'A', wager: 0, correct: true });
      } else {
        scoreClue(state, { playerResults: {} });
      }
    }
  }

  assert.equal(state.phase, 'quickMoney');
  assert.deepEqual(state.quickMoney.finalists, ['A', 'B']);
  assert.equal(state.quickMoney.active, true);
});

test('multiplier wager bounds and scoring', () => {
  const state = setup();
  state.round = 2;
  state.players = [
    { name: 'A', score: 300 },
    { name: 'B', score: 0 }
  ];

  selectClue(state, { categoryIndex: 0, clueIndex: 0 });
  assert.equal(state.revealedClue.isMogulMultiplier, true);

  const tooHigh = applyMultiplier(state, { playerName: 'A', wager: 301, correct: true });
  assert.equal(tooHigh.ok, false);

  const negative = applyMultiplier(state, { playerName: 'A', wager: -1, correct: true });
  assert.equal(negative.ok, false);

  const applied = applyMultiplier(state, { playerName: 'A', wager: 200, correct: false });
  assert.equal(applied.ok, true);

  const a = state.players.find((p) => p.name === 'A');
  assert.equal(a.score, 100);
});

test('Quick Money ordering and completion', () => {
  const state = setup(['A', 'B']);
  state.phase = 'quickMoney';
  state.quickMoney.active = true;
  state.quickMoney.finalists = ['A', 'B'];

  for (let i = 0; i < 5; i += 1) {
    advanceQuickMoney(state, { playerName: 'A', promptIndex: i, answer: 'x', points: 10 });
  }
  assert.equal(state.quickMoney.currentFinalistIndex, 1);
  assert.equal(state.quickMoney.completed, false);

  for (let i = 0; i < 5; i += 1) {
    advanceQuickMoney(state, { playerName: 'B', promptIndex: i, answer: 'y', points: 5 });
  }

  assert.equal(state.quickMoney.completed, true);
  assert.equal(state.quickMoney.active, false);
});
