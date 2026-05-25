function initializeGame({ playerNames, boardData, topFinalists = 2 }) {
  const players = (playerNames || []).map((name) => ({ name, score: 0 }));
  return {
    phase: 'round1',
    round: 1,
    players,
    boardData,
    revealedClue: null,
    config: {
      reopenOnIncorrect: true,
      maxAttemptsPerClue: 'unlimited',
      buzzTimeoutSeconds: 0,
      allowRebuzzBySamePlayer: false,
      tieBreakerMode: 'scoreFallback',
      roundMultipliers: { round1: 1, round2: 1 },
      customRoundValues: { round1: null, round2: null },
      wrongAnswerPenalty: { mode: 'fixed', value: 100 }
    },
    buzz: null,
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

function normalizeConfig(config = {}) {
  const tieBreakerModes = new Set(['hostPick', 'suddenDeath', 'scoreFallback']);
  const penaltyModes = new Set(['fixed', 'percent', 'none']);
  const normalizeRoundValueSet = (raw) => {
    if (!Array.isArray(raw)) return null;
    const cleaned = raw.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
    return cleaned.length ? cleaned : null;
  };
  const normalizeMultiplier = (value) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : 1;
  };
  const parsedMaxAttempts = config.maxAttemptsPerClue;
  const maxAttemptsPerClue = parsedMaxAttempts === 'unlimited' || parsedMaxAttempts === null || parsedMaxAttempts === undefined
    ? 'unlimited'
    : Number(parsedMaxAttempts);

  return {
    reopenOnIncorrect: config.reopenOnIncorrect !== false,
    maxAttemptsPerClue: maxAttemptsPerClue === 'unlimited' ? 'unlimited' : Math.max(1, Math.floor(maxAttemptsPerClue)),
    buzzTimeoutSeconds: Math.max(0, Number(config.buzzTimeoutSeconds) || 0),
    allowRebuzzBySamePlayer: Boolean(config.allowRebuzzBySamePlayer),
    tieBreakerMode: tieBreakerModes.has(config.tieBreakerMode) ? config.tieBreakerMode : 'scoreFallback',
    roundMultipliers: {
      round1: normalizeMultiplier(config.roundMultipliers?.round1),
      round2: normalizeMultiplier(config.roundMultipliers?.round2)
    },
    customRoundValues: {
      round1: normalizeRoundValueSet(config.customRoundValues?.round1),
      round2: normalizeRoundValueSet(config.customRoundValues?.round2)
    },
    wrongAnswerPenalty: {
      mode: penaltyModes.has(config.wrongAnswerPenalty?.mode) ? config.wrongAnswerPenalty.mode : 'fixed',
      value: Math.max(0, Number(config.wrongAnswerPenalty?.value) || 0)
    }
  };
}

function getTieGuidance(state) {
  const players = sortPlayers(state.players || []);
  if (players.length < 2) return { hasTie: false, tiedPlayers: [], mode: state.config?.tieBreakerMode || 'scoreFallback', message: '' };
  const topScore = players[0].score;
  const tiedPlayers = players.filter((p) => p.score === topScore).map((p) => p.name);
  const hasTie = tiedPlayers.length > 1;
  const mode = state.config?.tieBreakerMode || 'scoreFallback';
  const map = {
    hostPick: 'Host should manually pick advancing player(s).',
    suddenDeath: 'Play one sudden-death clue between tied players.',
    scoreFallback: 'Use configured score-based fallback to break tie.'
  };
  return { hasTie, tiedPlayers, mode, message: hasTie ? map[mode] : '' };
}

function getClueValue(state) {
  const roundKey = state.round === 2 ? 'round2' : 'round1';
  const clueIndex = Number(state.revealedClue?.clueIndex);
  const custom = state.config?.customRoundValues?.[roundKey];
  if (Array.isArray(custom) && Number.isFinite(clueIndex) && custom[clueIndex] !== undefined) {
    return Number(custom[clueIndex]);
  }
  const base = Number(state.revealedClue?.value) || 0;
  return base * Number(state.config?.roundMultipliers?.[roundKey] || 1);
}

function scoreForResult(player, result, clueValue, penaltyConfig) {
  if (result === 'correct') return { ...player, score: player.score + clueValue };
  if (result !== 'incorrect') return player;
  if (penaltyConfig?.mode === 'none') return player;
  if (penaltyConfig?.mode === 'percent') {
    const amount = Math.round((player.score * Number(penaltyConfig.value || 0)) / 100);
    return { ...player, score: player.score - amount };
  }
  return { ...player, score: player.score - clueValue };
}

function getRoundBoard(state) {
  return state.round === 1 ? state.boardData.round1 : state.boardData.round2;
}

function sortPlayers(players) {
  return [...players].sort((a, b) => b.score - a.score);
}

const QUICK_MONEY_POINTS_MIN = 0;
const QUICK_MONEY_POINTS_MAX = 1000;

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
      revealedClue: { ...clue, categoryIndex: Number(categoryIndex), clueIndex: Number(clueIndex), isMogulMultiplier },
      buzz: {
        open: false,
        lockedBy: null,
        lockedAt: null,
        attempts: [],
        eligiblePlayers: state.players.map((player) => player.name),
        timeoutAt: null
      }
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

  const clueValue = getClueValue(state);
  const penaltyConfig = state.config?.wrongAnswerPenalty || { mode: 'fixed', value: 0 };
  const players = state.players.map((player) => {
    const result = playerResults[player.name];
    return scoreForResult(player, result, clueValue, penaltyConfig);
  });

  let nextState = { ...state, players: sortPlayers(players), revealedClue: null, buzz: null };

  if (allCluesUsed(nextState)) {
    if (nextState.round === 1) {
      nextState = { ...nextState, round: 2, phase: 'round2' };
    } else {
      nextState = initializeQuickMoney({ ...nextState, phase: 'quickMoney' });
    }
  }

  nextState = { ...nextState, tieGuidance: getTieGuidance(nextState) };

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
    const multiplier = Number(state.config?.roundMultipliers?.round2 || 1);
    const adjustedAmount = amount * multiplier;
    return { ...p, score: p.score + (correct === 'true' || correct === true ? adjustedAmount : -adjustedAmount) };
  });

  let nextState = { ...state, players: sortPlayers(players), revealedClue: null, buzz: null };
  if (allCluesUsed(nextState)) {
    nextState = initializeQuickMoney({ ...nextState, phase: 'quickMoney' });
  }

  return { state: { ...nextState, tieGuidance: getTieGuidance(nextState) } };
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

  const normalizedAnswer = typeof answer === 'string' ? answer.trim() : '';
  if (!normalizedAnswer) return { state, error: 'Answer must be a non-empty string.' };

  const parsedPoints = Number(points);
  if (!Number.isFinite(parsedPoints)) {
    return { state, error: 'Points must be a finite number.' };
  }
  if (parsedPoints < QUICK_MONEY_POINTS_MIN || parsedPoints > QUICK_MONEY_POINTS_MAX) {
    return {
      state,
      error: `Points must be between ${QUICK_MONEY_POINTS_MIN} and ${QUICK_MONEY_POINTS_MAX}.`
    };
  }

  const answersForPlayer = state.quickMoney.answers[playerName] || [];
  if (answersForPlayer.some((entry) => entry.promptIndex === parsedPromptIndex)) {
    return { state, error: 'Duplicate submission for this finalist prompt.' };
  }

  const nextAnswers = {
    ...state.quickMoney.answers,
    [playerName]: [...answersForPlayer, { promptIndex: parsedPromptIndex, answer: normalizedAnswer, points: parsedPoints }]
  };

  const updatedPlayers = sortPlayers(state.players.map((p) =>
    p.name === playerName ? { ...p, score: p.score + parsedPoints } : p
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


function openBuzz(state) {
  if (!state.revealedClue) return { state, error: 'No active clue.' };
  if (!state.buzz) return { state, error: 'Buzz state is not initialized for this clue.' };
  if (state.buzz.lockedBy) return { state, error: 'Buzz is locked. Reset buzz before reopening.' };
  const timeoutAt = state.config?.buzzTimeoutSeconds > 0 ? Date.now() + (state.config.buzzTimeoutSeconds * 1000) : null;
  return { state: { ...state, buzz: { ...state.buzz, open: true, timeoutAt } } };
}

function resetBuzz(state) {
  if (!state.revealedClue) return { state, error: 'No active clue.' };
  if (!state.buzz) return { state, error: 'Buzz state is not initialized for this clue.' };
  return {
    state: {
      ...state,
      buzz: {
        ...state.buzz,
        open: false,
        lockedBy: null,
        lockedAt: null
      }
    }
  };
}

function lockBuzz(state, playerName, at = Date.now()) {
  if (!state.revealedClue) return { state, error: 'No active clue.' };
  if (!state.buzz || !state.buzz.open) return { state, error: 'Buzz window is closed.' };
  if (state.buzz.lockedBy) return { state, error: 'Buzz already locked.' };
  if (!state.players.some((player) => player.name === playerName)) return { state, error: 'Unknown player.' };
  if (!state.config?.allowRebuzzBySamePlayer && (state.buzz.attempts || []).some((attempt) => attempt.playerName === playerName)) {
    return { state, error: 'Player already attempted this clue.' };
  }

  const maxAttemptsPerClue = state.config?.maxAttemptsPerClue;
  if (maxAttemptsPerClue !== 'unlimited' && Number.isFinite(maxAttemptsPerClue) && (state.buzz.attempts || []).length >= Number(maxAttemptsPerClue)) {
    return { state, error: 'Maximum attempts reached for this clue.' };
  }

  return {
    state: {
      ...state,
      buzz: {
        ...state.buzz,
        open: false,
        lockedBy: playerName,
        lockedAt: Number(at) || Date.now(),
        attempts: [...(state.buzz.attempts || []), { playerName, at: Number(at) || Date.now() }],
        timeoutAt: null
      }
    }
  };
}

function applyScoreAndBuzzRules(state, playerResults = {}) {
  if (!state.revealedClue || state.revealedClue.isMogulMultiplier) return { state, error: 'No standard clue is active.' };
  const lockedPlayer = state.buzz?.lockedBy;
  if (!lockedPlayer) return { state, error: 'Select a buzz winner before scoring this clue.' };

  const lockedResult = playerResults[lockedPlayer] || 'skip';
  if (lockedResult !== 'incorrect') {
    return scoreClue(state, playerResults);
  }

  const updatedPlayers = state.players.map((player) => {
    const result = playerResults[player.name];
    return scoreForResult(player, result, getClueValue(state), state.config?.wrongAnswerPenalty || { mode: 'fixed', value: 0 });
  });

  if (!state.config?.reopenOnIncorrect) {
    return scoreClue({ ...state, players: updatedPlayers }, playerResults);
  }

  const maxAttempts = state.config?.maxAttemptsPerClue;
  const attemptsUsed = (state.buzz?.attempts || []).length;
  const hasAttemptsRemaining = maxAttempts === 'unlimited' || attemptsUsed < Number(maxAttempts);
  if (!hasAttemptsRemaining) {
    return scoreClue({ ...state, players: updatedPlayers }, playerResults);
  }

  return {
    state: {
      ...state,
      players: sortPlayers(updatedPlayers),
      buzz: {
        ...state.buzz,
        open: true,
        lockedBy: null,
        lockedAt: null,
        timeoutAt: state.config?.buzzTimeoutSeconds > 0 ? Date.now() + (state.config.buzzTimeoutSeconds * 1000) : null
      }
    }
  };
}

function startQuickMoneyTurn(state, seconds = 20, now = Date.now()) {
  if (state.phase !== 'quickMoney') return { state, error: 'Quick Money is not active.' };
  if (state.quickMoney.completed) return { state, error: 'Quick Money is already complete.' };

  return {
    state: {
      ...state,
      quickMoney: {
        ...state.quickMoney,
        turnActive: true,
        timerEndsAt: Number(now) + (Number(seconds || 20) * 1000)
      }
    }
  };
}

function updateConfig(state, configPatch = {}) {
  const nextState = { ...state, config: normalizeConfig({ ...(state.config || {}), ...configPatch }) };
  return { ...nextState, tieGuidance: getTieGuidance(nextState) };
}

module.exports = { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, initializeQuickMoney, allCluesUsed, openBuzz, resetBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig, normalizeConfig, getRoundBoard, startQuickMoneyTurn };
