const socket = io({ query: { role: 'viewer' } });

function createSoundboard() {
  const enabled = () => localStorage.getItem('gameshow:soundEnabled') !== 'false';
  const sounds = {
    clueReveal: document.getElementById('sfxClueReveal'),
    buzzOpen: document.getElementById('sfxBuzzOpen'),
    buzzLock: document.getElementById('sfxBuzzLock'),
    quickTimerStart: document.getElementById('sfxQuickTimerStart'),
    quickTimerExpiry: document.getElementById('sfxQuickTimerExpiry')
  };
  return {
    play(name) {
      if (!enabled()) return;
      const audio = sounds[name];
      if (!audio) return;
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
  };
}

const soundboard = createSoundboard();
let previousSignal = { revealed: null, buzzOpen: false, buzzLock: null, timerEndsAt: null, turnActive: false };
let previousScores = new Map();

function renderScoreboard(players) {
  const rows = players.map((p) => { const changed = previousScores.has(p.name) && previousScores.get(p.name) !== p.score; return `<tr class="${changed ? 'score-changed' : ''}"><td>${p.name}</td><td>${p.score}</td></tr>`; }).join('');
  document.getElementById('scoreboard').innerHTML = `<table><thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
  previousScores = new Map(players.map((p) => [p.name, p.score]));
}

function renderBoard(state) {
  const boardEl = document.getElementById('board');
  const phaseBanner = document.getElementById('phaseBanner');
  phaseBanner.textContent = `Phase: ${state.phase} | Round ${state.round}`;
  if (!state.board) { boardEl.innerHTML = '<p>Waiting for host to start the game.</p>'; return; }

  const categories = state.board.categories;
  const catHtml = categories.map((c) => `<div class="category">${c.name}</div>`).join('');
  let tiles = '';
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      const clue = categories[c].clues[r];
      tiles += `<div class="tile ${clue.used ? 'used':''}">${clue.used ? '' : clue.value}</div>`;
    }
  }

  boardEl.innerHTML = catHtml + tiles;
  const revealed = document.getElementById('revealed');
  revealed.innerHTML = state.revealedClue ? `<h3>Answer</h3><p>${state.revealedClue.answer}</p>` : '';
}

function renderQuickMoneyPhase(state) {
  let panel = document.getElementById('quickMoneyPanel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'quickMoneyPanel';
    const board = document.getElementById('board');
    board.parentNode.insertBefore(panel, board.nextSibling);
  }

  if (state.phase !== 'quickMoney') {
    panel.innerHTML = '';
    return;
  }

  const finalistName = state.quickMoney?.finalists?.[state.quickMoney.currentFinalistIndex] || '—';
  const promptIndex = Number(state.quickMoney?.promptIndex || 0);
  const promptText = state.quickMoneyPrompts?.[promptIndex] || 'Prompt unavailable';
  const revealPolicy = state.quickMoney?.turnActive ? 'Answers masked until host scores.' : 'Waiting for host to begin turn.';
  panel.innerHTML = `<h3>Quick Money</h3><p><strong>Active finalist:</strong> ${finalistName}</p><p><strong>Prompt ${promptIndex + 1} of 5:</strong> ${promptText}</p><p><strong>Answer reveal policy:</strong> ${revealPolicy}</p>`;
}

socket.on('state:update', (state) => {
  const now = Date.now();
  const revealedId = state.revealedClue ? `${state.round}:${state.revealedClue.answer}` : null;
  const buzzOpen = Boolean(state.buzz?.open);
  const buzzLock = state.buzz?.lockedAt || state.buzz?.lockedBy || null;
  const timerEndsAt = state.quickMoney?.timerEndsAt || null;
  const turnActive = Boolean(state.quickMoney?.turnActive);

  if (revealedId && revealedId !== previousSignal.revealed) soundboard.play('clueReveal');
  if (buzzOpen && !previousSignal.buzzOpen) soundboard.play('buzzOpen');
  if (buzzLock && buzzLock !== previousSignal.buzzLock) soundboard.play('buzzLock');
  if (turnActive && timerEndsAt && timerEndsAt !== previousSignal.timerEndsAt) soundboard.play('quickTimerStart');
  if (turnActive && timerEndsAt && timerEndsAt <= now && previousSignal.timerEndsAt && previousSignal.timerEndsAt > now) soundboard.play('quickTimerExpiry');

  previousSignal = { revealed: revealedId, buzzOpen, buzzLock, timerEndsAt, turnActive };
  renderScoreboard(state.players || []);
  renderBoard(state);
  renderQuickMoneyPhase(state);
});
