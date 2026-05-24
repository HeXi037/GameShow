const socket = io({ query: { role: 'viewer' } });

function renderScoreboard(players) {
  const rows = players.map((p) => `<tr><td>${p.name}</td><td>${p.score}</td></tr>`).join('');
  document.getElementById('scoreboard').innerHTML = `<table><thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
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
  renderScoreboard(state.players || []);
  renderBoard(state);
  renderQuickMoneyPhase(state);
});
