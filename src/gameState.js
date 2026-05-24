function initializeGame({ playerNames, boardData, topFinalists = 2 }) {
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
      turnActive: false,
      answers: {},
      timerEndsAt: null,
      active: false,
      completed: false,
      topFinalists
    }
  };
}

function getRoundBoard(state) {
  return state.round === 1 ? state.boardData.round1 : state.boardData.round2;
}

function sortPlayers(players) {
  return [...players].sort((a, b) => b.score - a.score);
}

function allCluesUsed(state, round = state.round) {
  const board = round === 1 ? state.boardData.round1 : state.boardData.round2;
  return board.categories.every((cat) => cat.clues.every((clue) => clue.used));
}

function selectClue(state, categoryIndex, clueIndex) {
  const board = getRoundBoard(state);
  const clue = board.categories?.[categoryIndex]?.clues?.[clueIndex];
  if (!clue) return { state, error: 'Clue not found.' };
  if (clue.used) return { state, error: 'Clue already used.' };

  const isMogulMultiplier = state.round === 2
    && Number(state.boardData.round2?.mogulMultiplier?.categoryIndex) === Number(categoryIndex)
    && Number(state.boardData.round2?.mogulMultiplier?.clueIndex) === Number(clueIndex);

  clue.used = true;
  return {
    state: {
      ...state,
      revealedClue: { ...clue, categoryIndex: Number(categoryIndex), clueIndex: Number(clueIndex), isMogulMultiplier }
    }
  };
}

function initializeQuickMoney(state, topN = state.quickMoney.topFinalists || 2) {
  const finalists = sortPlayers(state.players).slice(0, Number(topN) || 2).map((p) => p.name);
  return {
    ...state,
    quickMoney: {
      ...state.quickMoney,
      finalists,
      currentFinalistIndex: 0,
      promptIndex: 0,
      turnActive: false,
      answers: {},
      timerEndsAt: null,
      active: finalists.length > 0,
      completed: finalists.length === 0
    }
  };
}

function scoreClue(state, playerResults = {}) {
  if (!state.revealedClue) return { state, error: 'No active clue.' };
  if (state.revealedClue.isMogulMultiplier) return { state, error: 'Use multiplier scoring for this clue.' };

  const clueValue = Number(state.revealedClue.value);
  const players = state.players.map((player) => {
    const result = playerResults[player.name];
    if (result === 'correct') return { ...player, score: player.score + clueValue };
    if (result === 'incorrect') return { ...player, score: player.score - clueValue };
    return player;
  });

  let nextState = { ...state, players: sortPlayers(players), revealedClue: null };

  if (allCluesUsed(nextState)) {
    if (nextState.round === 1) {
      nextState = { ...nextState, round: 2, phase: 'round2' };
    } else {
      nextState = initializeQuickMoney({ ...nextState, phase: 'quickMoney' });
    }
  }

  return { state: nextState };
}

function applyMultiplier(state, { playerName, wager, correct }) {
  if (!state.revealedClue || !state.revealedClue.isMogulMultiplier) {
    return { state, error: 'Mogul Multiplier is not active.' };
  }

  const amount = Number(wager);
  if (!Number.isFinite(amount) || amount < 0) return { state, error: 'Wager must be a non-negative number.' };

  const player = state.players.find((p) => p.name === playerName);
  if (!player) return { state, error: 'Wager must target exactly one valid player.' };

  const maxWager = Math.max(0, Number(player.score));
  if (amount > maxWager) return { state, error: 'Wager cannot exceed player score.' };

  const players = state.players.map((p) => {
    if (p.name !== playerName) return p;
    return { ...p, score: p.score + (correct === 'true' || correct === true ? amount : -amount) };
  });

  let nextState = { ...state, players: sortPlayers(players), revealedClue: null };
  if (allCluesUsed(nextState)) {
    nextState = initializeQuickMoney({ ...nextState, phase: 'quickMoney' });
  }

  return { state: nextState };
}

function advanceQuickMoney(state, { playerName, promptIndex, answer, points }) {
  if (state.phase !== 'quickMoney') return { state, error: 'Quick Money is not active.' };
  if (state.quickMoney.completed) return { state, error: 'Quick Money is already complete.' };

  const parsedPromptIndex = Number(promptIndex);
  const activeFinalist = state.quickMoney.finalists[state.quickMoney.currentFinalistIndex];
  if (!activeFinalist) return { state, error: 'No active finalist.' };
  if (!state.quickMoney.turnActive) return { state, error: 'Turn has not started.' };
  if (playerName !== activeFinalist) return { state, error: 'Submission is not for the active finalist.' };
  if (parsedPromptIndex !== state.quickMoney.promptIndex) return { state, error: 'Submission is not for the active prompt.' };

  const answersForPlayer = state.quickMoney.answers[playerName] || [];
  if (answersForPlayer.some((entry) => entry.promptIndex === parsedPromptIndex)) {
    return { state, error: 'Duplicate submission for this finalist prompt.' };
  }

  const nextAnswers = {
    ...state.quickMoney.answers,
    [playerName]: [...answersForPlayer, { promptIndex: parsedPromptIndex, answer, points: Number(points) }]
  };

  const updatedPlayers = sortPlayers(state.players.map((p) =>
    p.name === playerName ? { ...p, score: p.score + Number(points) } : p
  ));

  const isLastPrompt = state.quickMoney.promptIndex >= 4;
  let quickMoney = { ...state.quickMoney, answers: nextAnswers };

  if (isLastPrompt) {
    quickMoney = {
      ...quickMoney,
      promptIndex: 0,
      currentFinalistIndex: quickMoney.currentFinalistIndex + 1,
      turnActive: false,
      timerEndsAt: null
    };
  } else {
    quickMoney = { ...quickMoney, promptIndex: quickMoney.promptIndex + 1 };
  }

  if (quickMoney.currentFinalistIndex >= quickMoney.finalists.length) {
    quickMoney = { ...quickMoney, completed: true, active: false, turnActive: false, timerEndsAt: null };
  }

  return { state: { ...state, players: updatedPlayers, quickMoney } };
}

module.exports = { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, initializeQuickMoney, allCluesUsed };
