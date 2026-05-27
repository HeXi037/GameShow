const test = require('node:test');
const assert = require('node:assert/strict');
const { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, openBuzz, resetBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig, getRoundBoard, startQuickMoneyTurn } = require('../src/gameState');

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


test('initializeGame supports non-default topFinalists', () => {
  const state = initializeGame({ playerNames: ['A', 'B', 'C', 'D'], boardData: makeBoard(), topFinalists: 4 });
  assert.equal(state.quickMoney.topFinalists, 4);
});

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

test('buzz state transitions: open -> lock -> reset -> reopen with deterministic timestamps', () => {
  const realNow = Date.now;
  Date.now = () => 1000;
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = updateConfig(state, { buzzTimeoutSeconds: 3 });
  state = selectClue(state, 0, 0).state;
  state = openBuzz(state).state;
  assert.equal(state.buzz.open, true);
  assert.equal(state.buzz.timeoutAt, 4000);

  state = lockBuzz(state, 'A', 1500).state;
  assert.equal(state.buzz.open, false);
  assert.equal(state.buzz.lockedBy, 'A');
  assert.equal(state.buzz.lockedAt, 1500);
  assert.deepEqual(state.buzz.attempts, [{ playerName: 'A', at: 1500 }]);

  state = resetBuzz(state).state;
  assert.equal(state.buzz.open, false);
  assert.equal(state.buzz.lockedBy, null);
  assert.equal(state.buzz.lockedAt, null);

  Date.now = () => 2000;
  state = openBuzz(state).state;
  assert.equal(state.buzz.open, true);
  assert.equal(state.buzz.timeoutAt, 5000);
  Date.now = realNow;
});


test('startQuickMoneyTurn sets turn active and timer', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = { ...state, phase: 'quickMoney', quickMoney: { ...state.quickMoney, completed: false } };

  const result = startQuickMoneyTurn(state, 15, 1000);
  assert.equal(result.error, undefined);
  assert.equal(result.state.quickMoney.turnActive, true);
  assert.equal(result.state.quickMoney.timerEndsAt, 16000);
});

test('startQuickMoneyTurn validates quick money phase and completion state', () => {
  const state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  assert.equal(startQuickMoneyTurn(state, 20).error, 'Quick Money is not active.');

  const completedState = {
    ...state,
    phase: 'quickMoney',
    quickMoney: { ...state.quickMoney, completed: true }
  };
  assert.equal(startQuickMoneyTurn(completedState, 20).error, 'Quick Money is already complete.');
});


test('advanceQuickMoney rejects malformed answer payloads', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state.phase = 'quickMoney';
  state.quickMoney = {
    ...state.quickMoney,
    finalists: ['A'],
    currentFinalistIndex: 0,
    promptIndex: 0,
    turnActive: true,
    active: true,
    completed: false,
    answers: {}
  };

  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: '', points: 10 }).error, 'Answer must be a non-empty string.');
  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: '   ', points: 10 }).error, 'Answer must be a non-empty string.');
  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: 123, points: 10 }).error, 'Answer must be a non-empty string.');
});

test('advanceQuickMoney rejects invalid points values', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state.phase = 'quickMoney';
  state.quickMoney = {
    ...state.quickMoney,
    finalists: ['A'],
    currentFinalistIndex: 0,
    promptIndex: 0,
    turnActive: true,
    active: true,
    completed: false,
    answers: {}
  };

  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: 'ok', points: Number.NaN }).error, 'Points must be a finite number.');
  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: 'ok', points: -1 }).error, 'Points must be between 0 and 1000.');
  assert.equal(advanceQuickMoney(state, { playerName: 'A', promptIndex: 0, answer: 'ok', points: 999999 }).error, 'Points must be between 0 and 1000.');
});

test('startQuickMoneyTurn caller-side seconds validation bounds', () => {
  const validBounds = [5, 120];
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = { ...state, phase: 'quickMoney', quickMoney: { ...state.quickMoney, completed: false } };

  validBounds.forEach((seconds) => {
    const result = startQuickMoneyTurn(state, seconds, 1000);
    assert.equal(result.error, undefined);
  });
});

test('getRoundBoard returns board for active round', () => {
  const state = initializeGame({ playerNames: ['A'], boardData: makeBoard() });
  assert.equal(getRoundBoard(state), state.boardData.round1);
  assert.equal(getRoundBoard({ ...state, round: 2 }), state.boardData.round2);
});

test('normalizeConfig keeps safe defaults for invalid extended config', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = updateConfig(state, {
    tieBreakerMode: 'bad-mode',
    roundMultipliers: { round1: -1, round2: 'oops' },
    customRoundValues: { round1: ['x'], round2: [] },
    wrongAnswerPenalty: { mode: 'invalid', value: -20 }
  });
  assert.equal(state.config.tieBreakerMode, 'scoreFallback');
  assert.deepEqual(state.config.roundMultipliers, { round1: 1, round2: 1 });
  assert.equal(state.config.customRoundValues.round1, null);
  assert.equal(state.config.wrongAnswerPenalty.mode, 'fixed');
  assert.equal(state.config.wrongAnswerPenalty.value, 0);
});

test('wrong-answer penalty percent and none modes branch correctly', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state.players = [{ name: 'A', score: 1000 }, { name: 'B', score: 0 }];
  state = updateConfig(state, { wrongAnswerPenalty: { mode: 'percent', value: 10 } });
  state = selectClue(state, 0, 0).state;
  state = scoreClue(state, { A: 'incorrect' }).state;
  assert.equal(state.players.find((p) => p.name === 'A').score, 900);

  state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state.players = [{ name: 'A', score: 1000 }, { name: 'B', score: 0 }];
  state = updateConfig(state, { wrongAnswerPenalty: { mode: 'none', value: 0 } });
  state = selectClue(state, 0, 0).state;
  state = scoreClue(state, { A: 'incorrect' }).state;
  assert.equal(state.players.find((p) => p.name === 'A').score, 1000);
});

test('round multiplier and custom values apply in scoring branches', () => {
  let state = initializeGame({ playerNames: ['A'], boardData: makeBoard() });
  state = updateConfig(state, { roundMultipliers: { round1: 2, round2: 3 }, customRoundValues: { round1: [111], round2: null } });
  state = selectClue(state, 0, 0).state;
  state = scoreClue(state, { A: 'correct' }).state;
  assert.equal(state.players[0].score, 111);

  state = { ...state, round: 2, phase: 'round2', revealedClue: { value: 200, isMogulMultiplier: true, clueIndex: 0 } };
  state = applyMultiplier(state, { playerName: 'A', wager: 30, correct: true }).state;
  assert.equal(state.players[0].score, 201);
});

test('tie detection emits guidance for configured modes', () => {
  let state = initializeGame({ playerNames: ['A', 'B'], boardData: makeBoard() });
  state = updateConfig(state, { tieBreakerMode: 'suddenDeath' });
  state = selectClue(state, 0, 0).state;
  state = scoreClue(state, { A: 'correct', B: 'correct' }).state;
  assert.equal(state.tieGuidance.hasTie, true);
  assert.equal(state.tieGuidance.mode, 'suddenDeath');
  assert.match(state.tieGuidance.message, /sudden-death/i);
});
