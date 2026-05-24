const socket = io({ query: { role: 'host' } });
let state = window.__INITIAL_STATE__ || {};

function setConnectionStatus(text, online) {
  const el = document.getElementById('hostConnectionStatus');
  if (!el) return;
  el.textContent = text;
  el.dataset.online = online ? 'true' : 'false';
}

function renderPresence() {
  const viewerCount = state.presence?.viewerConnections || 0;
  const viewerEl = document.getElementById('viewerCount');
  if (viewerEl) viewerEl.textContent = String(viewerCount);

  const hostPresentEl = document.getElementById('hostPresenceStatus');
  if (hostPresentEl) {
    hostPresentEl.textContent = state.presence?.hostConnected ? 'Connected' : 'Offline';
  }
}

function showReconnectNotice(message) {
  const list = document.getElementById('connectionNotices');
  if (!list) return;
  const item = document.createElement('li');
  item.textContent = message;
  list.prepend(item);
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
  const multiplierCard = document.getElementById('multiplierCard');
  if (!state.revealedClue) {
    el.innerHTML = 'No clue currently revealed.';
    multiplierCard.hidden = true;
    return;
  }

  const isMultiplier = Boolean(state.revealedClue.isMogulMultiplier);
  const indicator = isMultiplier ? '<p><strong>⚡ Mogul Multiplier clue is active.</strong></p>' : '';

  if (isMultiplier) {
    multiplierCard.hidden = false;
    el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p>${indicator}`;
    return;
  }

  multiplierCard.hidden = true;
  const fields = state.players.map((p) => `<label>${p.name}<select name="${p.name}"><option value="skip">Skip</option><option value="correct">Correct</option><option value="incorrect">Incorrect</option></select></label>`).join('');
  el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p>${indicator}<form id="scoreForm">${fields}<button type="submit">Apply Scores</button></form>`;
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
  setConnectionStatus('Connected', true);
});

socket.on('disconnect', () => {
  setConnectionStatus('Disconnected (reconnecting...)', false);
});

socket.io.on('reconnect', () => {
  const now = Date.now();
  if (state.revealedClue) {
    showReconnectNotice('Reconnected while a clue reveal was active. Re-check scoring before applying changes.');
  }
  if (state.quickMoney?.timerEndsAt && state.quickMoney.timerEndsAt > now) {
    showReconnectNotice('Reconnected during an active Quick Money timer. Verify remaining time before continuing.');
  }
});

renderScoreboard(state.players || []);
renderHostBoard();
renderReveal();
renderPresence();
setConnectionStatus(socket.connected ? 'Connected' : 'Connecting...', socket.connected);
