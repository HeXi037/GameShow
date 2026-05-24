const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, openBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig } = require('../src/gameState');

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

test('variable-player score updates (+/-/skip)', () => {
  let state = initializeGame({ playerNames: ['A', 'B', 'C'], boardData: makeBoard() });
  state = selectClue(state, 0, 0).state;
  state = scoreClue(state, { A: 'correct', B: 'incorrect', C: 'skip' }).state;
  assert.equal(state.players.find((p) => p.name === 'A').score, 100);
  assert.equal(state.players.find((p) => p.name === 'B').score, -100);
  assert.equal(state.players.find((p) => p.name === 'C').score, 0);
});

test('used-clue lockout', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = selectClue(state, 0, 0).state;
  const result = selectClue(state, 0, 0);
  assert.equal(result.error, 'Clue already used.');
});

test('round 1 -> round 2 transition', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 5; i++) {
      state = selectClue(state, c, i).state;
      state = scoreClue(state, { A: 'correct' }).state;
    }
  }
  assert.equal(state.round, 2);
  assert.equal(state.phase, 'round2');
});

test('round 2 completion -> Quick Money finalists selection', () => {
  let state = initializeGame({ playerNames: ['A', 'B', 'C'], boardData: makeBoard() });
  state = { ...state, phase: 'round2', round: 2, players: [{ name: 'A', score: 500 }, { name: 'B', score: 300 }, { name: 'C', score: 400 }] };
  for (let c = 0; c < 5; c++) {
    for (let i = 0; i < 5; i++) state.boardData.round2.categories[c].clues[i].used = true;
  }
  state.revealedClue = { value: 200, isMogulMultiplier: false };
  state = scoreClue(state, {}).state;
  assert.equal(state.phase, 'quickMoney');
  assert.deepEqual(state.quickMoney.finalists, ['A', 'C']);
});

test('multiplier wager bounds and scoring', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = { ...state, phase: 'round2', round: 2, players: [{ name: 'A', score: 500 }, { name: 'B', score: 0 }] };
  state = selectClue(state, 1, 2).state;
  assert.equal(applyMultiplier(state, { playerName: 'A', wager: 600, correct: true }).error, 'Wager cannot exceed player score.');
  state = applyMultiplier(state, { playerName: 'A', wager: 200, correct: true }).state;
  assert.equal(state.players.find((p) => p.name === 'A').score, 700);
});

test('Quick Money ordering and completion', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state.phase = 'quickMoney';
  state.quickMoney = {
    ...state.quickMoney,
    finalists: ['A', 'B'],
    currentFinalistIndex: 0,
    promptIndex: 0,
    turnActive: true,
    active: true,
    completed: false,
    answers: {}
  };

  for (let i = 0; i < 5; i++) {
    state = advanceQuickMoney(state, { playerName: 'A', promptIndex: i, answer: 'x', points: 10 }).state;
    if (i < 4) assert.equal(state.quickMoney.currentFinalistIndex, 0);
  }
  assert.equal(state.quickMoney.currentFinalistIndex, 1);
  assert.equal(state.quickMoney.turnActive, false);

  state.quickMoney.turnActive = true;
  for (let i = 0; i < 5; i++) {
    state = advanceQuickMoney(state, { playerName: 'B', promptIndex: i, answer: 'y', points: 5 }).state;
    if (i === 4) assert.equal(state.quickMoney.completed, true);
  }
});


test('incorrect answer reopens buzz when configured', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = selectClue(state, 0, 0).state;
  state = openBuzz(state).state;
  state = lockBuzz(state, 'A').state;
  state = applyScoreAndBuzzRules(state, { A: 'incorrect' }).state;
  assert.equal(state.revealedClue.value, 100);
  assert.equal(state.buzz.open, true);
  assert.equal(state.buzz.lockedBy, null);
});

test('maxAttemptsPerClue enforces clue close after configured attempts', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = updateConfig(state, { maxAttemptsPerClue: 1, reopenOnIncorrect: true });
  state = selectClue(state, 0, 0).state;
  state = openBuzz(state).state;
  state = lockBuzz(state, 'A').state;
  state = applyScoreAndBuzzRules(state, { A: 'incorrect' }).state;
  assert.equal(state.revealedClue, null);
});
