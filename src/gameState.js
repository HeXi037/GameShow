function initializeGame({ playerNames, boardData }) {
  const players = (playerNames || []).map((name) => ({ name, score: 0 }));

  return {
    phase: 'round1',
    round: 1,
    players,
    boardData,
    revealedClue: null,
    quickMoney: {
      finalists: [],
      currentFinalistIndex: 0,
      promptIndex: 0,
      answers: {},
      timerEndsAt: null,
      active: false,
      completed: false
    }
  };
}

function getRoundBoard(state, round = state.round) {
  return round === 1 ? state.boardData.round1 : state.boardData.round2;
}

function allCluesUsed(state, round = state.round) {
  const board = getRoundBoard(state, round);
  return board.categories.every((cat) => cat.clues.every((clue) => clue.used));
}

function selectClue(state, { categoryIndex, clueIndex }) {
  const board = getRoundBoard(state);
  const clue = board.categories?.[categoryIndex]?.clues?.[clueIndex];
  if (!clue) return { ok: false, error: 'Clue not found.' };
  if (clue.used) return { ok: false, error: 'Clue already used.' };

  let isMogulMultiplier = false;
  if (state.round === 2) {
    const multiplier = state.boardData.round2?.mogulMultiplier;
    isMogulMultiplier =
      Number(multiplier?.categoryIndex) === Number(categoryIndex) &&
      Number(multiplier?.clueIndex) === Number(clueIndex);
  }

  clue.used = true;
  state.revealedClue = { ...clue, categoryIndex, clueIndex, isMogulMultiplier };
  return { ok: true, state };
}

function sortPlayers(state) {
  state.players.sort((a, b) => b.score - a.score);
}

function maybeAdvanceRound(state) {
  if (!allCluesUsed(state)) return;

  if (state.round === 1) {
    state.round = 2;
    state.phase = 'round2';
    return;
  }

  state.phase = 'quickMoney';
  state.quickMoney.finalists = [...state.players].slice(0, 2).map((p) => p.name);
  state.quickMoney.active = true;
}

function scoreClue(state, { playerResults }) {
  if (!state.revealedClue) return { ok: false, error: 'No active clue.' };
  if (state.revealedClue.isMogulMultiplier) {
    return { ok: false, error: 'Use multiplier scoring for this clue.' };
  }

  const clueValue = Number(state.revealedClue.value);
  Object.entries(playerResults || {}).forEach(([name, result]) => {
    const player = state.players.find((p) => p.name === name);
    if (!player || result === 'skip') return;
    if (result === 'correct') player.score += clueValue;
    if (result === 'incorrect') player.score -= clueValue;
  });

  sortPlayers(state);
  state.revealedClue = null;
  maybeAdvanceRound(state);
  return { ok: true, state };
}

function applyMultiplier(state, { playerName, wager, correct }) {
  if (!state.revealedClue || !state.revealedClue.isMogulMultiplier) {
    return { ok: false, error: 'Mogul Multiplier is not active.' };
  }

  const matches = state.players.filter((p) => p.name === playerName);
  if (matches.length !== 1) {
    return { ok: false, error: 'Wager must target exactly one valid player.' };
  }

  const amount = Number(wager);
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, error: 'Wager must be a non-negative number.' };
  }

  const player = matches[0];
  const maxWager = Math.max(0, Number(player.score));
  if (amount > maxWager) {
    return { ok: false, error: 'Wager cannot exceed player score.' };
  }

  player.score += correct === true || correct === 'true' ? amount : -amount;
  sortPlayers(state);
  state.revealedClue = null;
  maybeAdvanceRound(state);
  return { ok: true, state };
}

function advanceQuickMoney(state, { playerName, promptIndex, answer, points }) {
  if (!state.quickMoney.answers[playerName]) state.quickMoney.answers[playerName] = [];
  state.quickMoney.answers[playerName].push({ promptIndex: Number(promptIndex), answer, points: Number(points) });

  const player = state.players.find((p) => p.name === playerName);
  if (player) player.score += Number(points);
  sortPlayers(state);

  const finalists = state.quickMoney.finalists || [];
  const currentFinalist = finalists[state.quickMoney.currentFinalistIndex];
  const currentAnswers = state.quickMoney.answers[currentFinalist] || [];

  if (currentAnswers.length >= 5) {
    if (state.quickMoney.currentFinalistIndex < finalists.length - 1) {
      state.quickMoney.currentFinalistIndex += 1;
      state.quickMoney.promptIndex = 0;
    } else {
      state.quickMoney.completed = true;
      state.quickMoney.active = false;
    }
  } else {
    state.quickMoney.promptIndex = currentAnswers.length;
  }

  return { ok: true, state };
}

module.exports = {
  initializeGame,
  selectClue,
  scoreClue,
  applyMultiplier,
  advanceQuickMoney,
  allCluesUsed
};
