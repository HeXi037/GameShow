const socket = io();

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

function renderQuickMoneyPanel(state) {
  const panel = document.getElementById('quickMoneyPanel');
  if (!panel) return;
  if (state.phase !== 'quickMoney') {
    panel.innerHTML = '';
    return;
  }

  const qm = state.quickMoney || {};
  const prompts = state.quickMoneyPrompts || [];
  const finalist = (qm.finalists || [])[qm.currentFinalistIndex] || '—';
  const promptNum = Number(qm.promptIndex || 0) + 1;
  const promptText = prompts[qm.promptIndex] || '—';

  panel.innerHTML = `
    <h3>Quick Money</h3>
    <p><b>Active finalist:</b> ${finalist}</p>
    <p><b>Prompt ${promptNum} of 5:</b> ${promptText}</p>
    <p><b>Answer reveal:</b> Masked until host scoring (policy enabled).</p>
  `;
}

socket.on('state:update', (state) => {
  renderScoreboard(state.players || []);
  renderBoard(state);
  renderQuickMoneyPanel(state);
});
