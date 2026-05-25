const stateRoom = (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.roomCode) || '';
const socket = io({ query: { role: 'host', roomCode: stateRoom } });
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

  const playerCount = state.presence?.playerConnections || 0;
  const playerCountEl = document.getElementById('playerConnectionCount');
  if (playerCountEl) playerCountEl.textContent = String(playerCount);

  const playerSessions = document.getElementById('playerSessions');
  if (playerSessions) {
    const names = state.presence?.playerNames || [];
    playerSessions.textContent = names.length ? names.join(', ') : 'None';
  }

  const hostPresentEl = document.getElementById('hostPresenceStatus');
  if (hostPresentEl) {
    hostPresentEl.textContent = state.presence?.hostConnected ? 'Connected' : 'Offline';
  }
}

function renderJoinCodes() {
  const wrap = document.getElementById('joinLinks');
  if (!wrap) return;
  const joinCodes = state.joinCodes || {};
  const players = Object.keys(joinCodes);
  if (!players.length) {
    wrap.innerHTML = '<p>No join codes generated yet.</p>';
    return;
  }
  const rows = players.map((playerName) => {
    const code = joinCodes[playerName].code;
    const fullLink = `${window.location.origin}/join?room=${encodeURIComponent(state.roomCode||'')}&code=${encodeURIComponent(code)}`;
    return `<tr><td>${playerName}</td><td><code>${code}</code></td><td><a href="${fullLink}" target="_blank" rel="noopener noreferrer">${fullLink}</a></td></tr>`;
  }).join('');
  wrap.innerHTML = `<table><thead><tr><th>Player</th><th>Join Code</th><th>Join Link</th></tr></thead><tbody>${rows}</tbody></table>`;
}


function renderRules() {
  const form = document.getElementById('rulesForm');
  if (!form) return;
  const config = state.config || {};
  form.reopenOnIncorrect.checked = Boolean(config.reopenOnIncorrect);
  form.allowRebuzzBySamePlayer.checked = Boolean(config.allowRebuzzBySamePlayer);
  form.buzzTimeoutSeconds.value = Number(config.buzzTimeoutSeconds || 0);
  form.maxAttemptsPerClue.value = config.maxAttemptsPerClue === 'unlimited' ? '' : String(config.maxAttemptsPerClue || '');
}

function showReconnectNotice(message) {
  const list = document.getElementById('connectionNotices');
  if (!list) return;
  const item = document.createElement('li');
  item.textContent = message;
  list.prepend(item);
}

function showOperationalNotice(message, level = 'info') {
  const prefix = level === 'warning' ? '⚠️' : 'ℹ️';
  showReconnectNotice(`${prefix} ${message}`);
}

function renderScoreboard(players) {
  const rows = players.map((p) => `<tr><td>${p.name}</td><td>${p.score}</td></tr>`).join('');
  document.getElementById('scoreboard').innerHTML = `<table><thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function parseHostError(response) {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const payload = await response.json();
      if (payload?.error?.message) {
        return payload.error.message;
      }
    } catch (error) {
      // Fall through to text parsing for backward compatibility.
    }
  }

  try {
    const text = await response.text();
    return text || `Request failed (${response.status})`;
  } catch (error) {
    return `Request failed (${response.status})`;
  }
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await parseHostError(response);
    showOperationalNotice(message, 'warning');
    throw new Error(message);
  }

  return response;
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
  const buzz = state.buzz || { open: false, lockedBy: null, lockedAt: null };
  const buzzState = buzz.lockedBy ? 'Locked' : (buzz.open ? 'Open' : 'Closed');
  const buzzStatus = buzz.lockedBy ? `Locked by ${buzz.lockedBy}` : buzzState;
  const lockTime = buzz.lockedAt ? new Date(buzz.lockedAt).toLocaleTimeString() : '—';
  const winnerPanel = `<p><b>Buzz Status:</b> ${buzzState}</p><p><b>Winner:</b> ${buzz.lockedBy || 'None'}</p><p><b>Lock Time:</b> ${lockTime}</p>`;
  const indicator = isMultiplier ? '<p><strong>⚡ Mogul Multiplier clue is active.</strong></p>' : '';
  const config = state.config || {};
  const ruleSummary = `<p><b>Rules:</b> reopenOnIncorrect=${Boolean(config.reopenOnIncorrect)}, maxAttemptsPerClue=${config.maxAttemptsPerClue ?? 'unlimited'}, buzzTimeoutSeconds=${Number(config.buzzTimeoutSeconds || 0)}, allowRebuzzBySamePlayer=${Boolean(config.allowRebuzzBySamePlayer)}</p>`;

  if (isMultiplier) {
    multiplierCard.hidden = false;
    el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p><p><b>Buzz:</b> ${buzzStatus}</p>${winnerPanel}${indicator}${ruleSummary}`;
    return;
  }

  multiplierCard.hidden = true;
  const fields = state.players.map((p) => `<label>${p.name}<select name="${p.name}"><option value="skip">Skip</option><option value="correct">Correct</option><option value="incorrect">Incorrect</option></select></label>`).join('');
  el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p><p><b>Buzz:</b> ${buzzStatus}</p>${winnerPanel}${indicator}${ruleSummary}<div class="controls"><button id="openBuzz" type="button" ${buzz.open || buzz.lockedBy ? 'disabled' : ''}>Open Buzz</button><button id="resetBuzz" type="button" ${!buzz.lockedBy && !buzz.open ? 'disabled' : ''}>Reset Buzz</button></div><form id="scoreForm">${fields}<button type="submit" ${!buzz.lockedBy ? 'disabled' : ''}>Apply Scores</button></form>`;
  const openBuzzButton = document.getElementById('openBuzz');
  if (openBuzzButton) {
    openBuzzButton.addEventListener('click', async () => {
      await post('/host/open-buzz', {});
    });
  }

  const resetBuzzButton = document.getElementById('resetBuzz');
  if (resetBuzzButton) {
    resetBuzzButton.addEventListener('click', async () => {
      await post('/host/reset-buzz', {});
    });
  }

  document.getElementById('scoreForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(e.target);
    const results = {};
    for (const [k,v] of data.entries()) results[k]=v;
    await post('/host/score-clue', { playerResults: results });
  });
}

function renderQuickMoneyPanel() {
  const panel = document.getElementById('quickMoneyStatus');
  if (!panel) return;

  if (state.phase !== 'quickMoney') {
    panel.innerHTML = '<p>Quick Money has not started.</p>';
    return;
  }

  const quickMoney = state.quickMoney || {};
  const prompts = state.quickMoneyPrompts || [];
  const finalistName = quickMoney.finalists?.[quickMoney.currentFinalistIndex] || '—';
  const promptNumber = Number(quickMoney.promptIndex || 0) + 1;
  const promptText = prompts[quickMoney.promptIndex] || 'Prompt unavailable';
  panel.innerHTML = `<p><strong>Finalist:</strong> ${finalistName}</p><p><strong>Prompt ${promptNumber}:</strong> ${promptText}</p><p><strong>Turn Active:</strong> ${quickMoney.turnActive ? 'Yes' : 'No'}</p><p><strong>Timer:</strong> <span id="quickMoneyCountdown">—</span></p>`;
}

function renderQuickMoneyCountdown() {
  const countdownEl = document.getElementById('quickMoneyCountdown');
  if (!countdownEl) return;
  const endsAt = state.quickMoney?.timerEndsAt;
  if (!endsAt || !state.quickMoney?.turnActive) {
    countdownEl.textContent = 'Not running';
    return;
  }
  const remainingMs = Math.max(0, endsAt - Date.now());
  countdownEl.textContent = `${Math.ceil(remainingMs / 1000)}s`;
}


document.getElementById('rulesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const maxAttempts = String(fd.get('maxAttemptsPerClue') || '').trim();
  await post('/host/config', {
    reopenOnIncorrect: fd.get('reopenOnIncorrect') === 'on',
    allowRebuzzBySamePlayer: fd.get('allowRebuzzBySamePlayer') === 'on',
    buzzTimeoutSeconds: Number(fd.get('buzzTimeoutSeconds') || 0),
    maxAttemptsPerClue: maxAttempts ? Number(maxAttempts) : 'unlimited'
  });
});

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
  renderQuickMoneyPanel();
  renderQuickMoneyCountdown();
  renderPresence();
  renderJoinCodes();
  renderRules();
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

socket.on('host:notice', ({ message, level }) => {
  showOperationalNotice(message, level);
});

renderScoreboard(state.players || []);
renderHostBoard();
renderReveal();
renderQuickMoneyPanel();
renderQuickMoneyCountdown();
renderPresence();
renderJoinCodes();
renderRules();
setConnectionStatus(socket.connected ? 'Connected' : 'Connecting...', socket.connected);

setInterval(renderQuickMoneyCountdown, 250);

async function refreshSessions() {
  const res = await fetch('/host/sessions');
  if (!res.ok) return;
  const payload = await res.json();
  const wrap = document.getElementById('sessionList');
  if (!wrap) return;
  const sessions = payload.sessions || [];
  if (!sessions.length) {
    wrap.innerHTML = '<p>No saved sessions.</p>';
    return;
  }
  wrap.innerHTML = sessions.map((s) => `<div><code>${s.roomCode}</code> (${s.archived ? 'archived' : 'active'}) <button data-resume="${s.roomCode}">Resume</button> <button data-archive="${s.roomCode}">Archive</button></div>`).join('');
  wrap.querySelectorAll('button[data-resume]').forEach((btn) => btn.addEventListener('click', async () => {
    await post('/host/resume', { roomCode: btn.dataset.resume });
    window.location.reload();
  }));
  wrap.querySelectorAll('button[data-archive]').forEach((btn) => btn.addEventListener('click', async () => {
    await post('/host/archive', { roomCode: btn.dataset.archive });
    await refreshSessions();
  }));
}

const refreshButton = document.getElementById('refreshSessions');
if (refreshButton) refreshButton.addEventListener('click', refreshSessions);
refreshSessions();
