const socket = io({ auth: { role: 'host' } });
let state = window.__INITIAL_STATE__ || {};

function pushNotice(message) {
  const notices = document.getElementById('connectionNotices');
  if (!notices) return;
  const row = document.createElement('p');
  row.textContent = message;
  notices.prepend(row);
  while (notices.children.length > 4) notices.removeChild(notices.lastChild);
}

function updateConnectionStatus() {
  const status = document.getElementById('hostConnectionStatus');
  if (!status) return;
  status.textContent = socket.connected ? 'Connected' : 'Disconnected';
}

function renderPresence() {
  const viewerCount = document.getElementById('viewerCount');
  const socketCount = document.getElementById('socketCount');
  const presence = state.presence || {};
  if (viewerCount) viewerCount.textContent = String(presence.viewers || 0);
  if (socketCount) socketCount.textContent = String(presence.totalSockets || 0);
}

function activeSessionNoticeReason() {
  if (state.revealedClue) return 'an active reveal';
  if (state.quickMoney?.timerEndsAt && Date.now() < Number(state.quickMoney.timerEndsAt)) return 'an active Quick Money timer';
  return null;
}

function renderScoreboard(players) {
  const rows = players.map((p) => `<tr><td>${p.name}</td><td>${p.score}</td></tr>`).join('');
  document.getElementById('scoreboard').innerHTML = `<table><thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function post(url, payload) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

function renderHostBoard() {
  const wrap = document.getElementById('hostBoard');
  if (!state.board) { wrap.innerHTML = 'No game loaded.'; return; }
  let html = '<div class="board">';
  html += state.board.categories.map((c) => `<div class="category">${c.name}</div>`).join('');
  for (let r = 0; r < 5; r += 1) {
    for (let c = 0; c < 5; c += 1) {
      const clue = state.board.categories[c].clues[r];
      html += `<button class="tile ${clue.used?'used':''}" data-c="${c}" data-r="${r}" ${clue.used?'disabled':''}>${clue.value}</button>`;
    }
  }
  html += '</div>';
  wrap.innerHTML = html;
  wrap.querySelectorAll('button[data-c]').forEach((btn) => {
    btn.addEventListener('click', () => post('/host/select-clue', { categoryIndex: Number(btn.dataset.c), clueIndex: Number(btn.dataset.r) }));
  });
}

function renderReveal() {
  const el = document.getElementById('hostReveal');
  if (!state.revealedClue) { el.innerHTML = 'No clue currently revealed.'; return; }
  const fields = state.players.map((p) => `<label>${p.name}<select name="${p.name}"><option value="skip">Skip</option><option value="correct">Correct</option><option value="incorrect">Incorrect</option></select></label>`).join('');
  el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p><form id="scoreForm">${fields}<button type="submit">Apply Scores</button></form>`;
  document.getElementById('scoreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const results = {};
    for (const [k,v] of data.entries()) results[k]=v;
    await post('/host/score-clue', { playerResults: results });
  });
}

document.getElementById('multiplierForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  await post('/host/mogul-multiplier', data);
});

document.getElementById('quickTimer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  await post('/host/quick-money/start-turn', data);
});

document.getElementById('quickSubmit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target).entries());
  await post('/host/quick-money/submit', data);
});

socket.on('state:update', (next) => {
  state = next;
  renderScoreboard(state.players || []);
  renderHostBoard();
  renderReveal();
  renderPresence();
});

socket.on('connect', () => {
  updateConnectionStatus();
  socket.emit('presence:set-role', 'host');
});

socket.on('disconnect', () => {
  updateConnectionStatus();
});

socket.io.on('reconnect', () => {
  updateConnectionStatus();
  socket.emit('presence:set-role', 'host');
  const reason = activeSessionNoticeReason();
  if (reason) {
    pushNotice(`Reconnected during ${reason}. Please verify the game state before continuing.`);
  } else {
    pushNotice('Reconnected to server.');
  }
});

socket.io.on('reconnect_attempt', () => {
  updateConnectionStatus();
});

renderScoreboard(state.players || []);
renderHostBoard();
renderReveal();
renderPresence();
updateConnectionStatus();
