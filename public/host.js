const DEFAULT_LOCALE = 'en';
const requestedLocale = (document.documentElement.lang || navigator.language || DEFAULT_LOCALE).split('-')[0].toLowerCase();
let i18n = {};
function t(key, fallback = key) {
  return key.split('.').reduce((acc, part) => (acc && acc[part] !== undefined ? acc[part] : null), i18n) ?? fallback;
}
async function loadTranslations(scope) {
  const files = requestedLocale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [requestedLocale, DEFAULT_LOCALE];
  for (const locale of files) {
    try {
      const res = await fetch(`/i18n/${locale}.json`);
      if (!res.ok) continue;
      const payload = await res.json();
      i18n = { ...payload };
      if (payload[scope]) break;
    } catch (_) {}
  }
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const text = t(el.dataset.i18n, el.textContent);
    el.textContent = text;
  });
}
const stateRoom = (window.__INITIAL_STATE__ && window.__INITIAL_STATE__.roomCode) || '';
const socket = io({ query: { role: 'host', roomCode: stateRoom } });
let state = window.__INITIAL_STATE__ || {};

function createSoundboard() {
  const sounds = {
    clueReveal: document.getElementById('sfxClueReveal'),
    buzzOpen: document.getElementById('sfxBuzzOpen'),
    buzzLock: document.getElementById('sfxBuzzLock'),
    quickTimerStart: document.getElementById('sfxQuickTimerStart'),
    quickTimerExpiry: document.getElementById('sfxQuickTimerExpiry')
  };
  const enabled = () => localStorage.getItem('gameshow:soundEnabled') !== 'false';
  return {
    play(name) {
      if (!enabled()) return;
      const a = sounds[name];
      if (!a) return;
      a.currentTime = 0;
      a.play().catch(() => {});
    },
    setEnabled(value) { localStorage.setItem('gameshow:soundEnabled', value ? 'true' : 'false'); }
  };
}
const soundboard = createSoundboard();
let previousSignal = { revealed: null, buzzOpen: false, buzzLock: null, timerEndsAt: null, turnActive: false };
let previousScores = new Map();

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
    wrap.innerHTML = `<p>${t('host.noJoinCodes','No join codes generated yet.')}</p>`;
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
  form.tieBreakerMode.value = config.tieBreakerMode || 'scoreFallback';
  form.round1Multiplier.value = Number(config.roundMultipliers?.round1 || 1);
  form.round2Multiplier.value = Number(config.roundMultipliers?.round2 || 1);
  form.round1Values.value = Array.isArray(config.customRoundValues?.round1) ? config.customRoundValues.round1.join(',') : '';
  form.round2Values.value = Array.isArray(config.customRoundValues?.round2) ? config.customRoundValues.round2.join(',') : '';
  form.wrongAnswerPenaltyMode.value = config.wrongAnswerPenalty?.mode || 'fixed';
  form.wrongAnswerPenaltyValue.value = Number(config.wrongAnswerPenalty?.value || 0);
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
  const rows = players.map((p) => { const changed = previousScores.has(p.name) && previousScores.get(p.name) !== p.score; return `<tr class="${changed ? 'score-changed' : ''}"><td>${p.name}</td><td>${p.score}</td></tr>`; }).join('');
  document.getElementById('scoreboard').innerHTML = `<table><thead><tr><th>Player</th><th>Score</th></tr></thead><tbody>${rows}</tbody></table>`;
  previousScores = new Map(players.map((p) => [p.name, p.score]));
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
  if (!state.board) { wrap.innerHTML = t('host.noGameLoaded','No game loaded.'); return; }
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
    el.innerHTML = t('host.noClueRevealed','No clue currently revealed.');
    multiplierCard.hidden = true;
    return;
  }

  const isMultiplier = Boolean(state.revealedClue.isMogulMultiplier);
  const buzz = state.buzz || { open: false, lockedBy: null, lockedAt: null };
  const buzzState = buzz.lockedBy ? 'Locked' : (buzz.open ? 'Open' : 'Closed');
  const buzzStatus = buzz.lockedBy ? `Locked by ${buzz.lockedBy}` : buzzState;
  const lockTime = buzz.lockedAt ? new Date(buzz.lockedAt).toLocaleTimeString() : '—';
  const winnerClass = buzz.lockedBy ? 'buzz-winner' : '';
  const pendingAnswer = buzz.lockedBy ? state.answerCapture?.byPlayer?.[buzz.lockedBy] : null;
  const pendingAnswerText = pendingAnswer?.answer || '—';
  const winnerPanel = `<p><b>Buzz Status:</b> ${buzzState}</p><p class="${winnerClass}"><b>Winner:</b> ${buzz.lockedBy || 'None'}</p><p><b>Lock Time:</b> ${lockTime}</p><p><b>Captured answer:</b> ${pendingAnswerText}</p>`;
  const indicator = isMultiplier ? '<p><strong>⚡ Mogul Multiplier clue is active.</strong></p>' : '';
  const media = state.revealedClue.media;
  const mediaHtml = media ? renderClueMedia(media, 'host') : '';
  const config = state.config || {};
  const tieGuidance = state.tieGuidance?.hasTie
    ? `<p><b>Tie Guidance:</b> ${state.tieGuidance.message} (players: ${(state.tieGuidance.tiedPlayers || []).join(', ')})</p>`
    : '<p><b>Tie Guidance:</b> No tie currently detected.</p>';
  const ruleSummary = `<p><b>Rules:</b> reopenOnIncorrect=${Boolean(config.reopenOnIncorrect)}, maxAttemptsPerClue=${config.maxAttemptsPerClue ?? 'unlimited'}, buzzTimeoutSeconds=${Number(config.buzzTimeoutSeconds || 0)}, allowRebuzzBySamePlayer=${Boolean(config.allowRebuzzBySamePlayer)}, tieBreakerMode=${config.tieBreakerMode || 'scoreFallback'}, round1Multiplier=${Number(config.roundMultipliers?.round1 || 1)}, round2Multiplier=${Number(config.roundMultipliers?.round2 || 1)}, wrongAnswerPenalty=${config.wrongAnswerPenalty?.mode || 'fixed'}:${Number(config.wrongAnswerPenalty?.value || 0)}</p>${tieGuidance}`;

  if (isMultiplier) {
    multiplierCard.hidden = false;
    el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p>${mediaHtml}<p><b>Buzz:</b> ${buzzStatus}</p>${winnerPanel}${indicator}${ruleSummary}`;
    return;
  }

  multiplierCard.hidden = true;
  const fields = state.players.map((p) => `<label>${p.name}<select name="${p.name}"><option value="skip">Skip</option><option value="correct">Correct</option><option value="incorrect">Incorrect</option></select></label>`).join('');
  el.innerHTML = `<p><b>Answer:</b> ${state.revealedClue.answer}</p><p><b>Expected question:</b> ${state.revealedClue.question}</p>${mediaHtml}<p><b>Buzz:</b> ${buzzStatus}</p>${winnerPanel}${indicator}${ruleSummary}<div class="controls"><button id="openBuzz" type="button" ${buzz.open || buzz.lockedBy ? 'disabled' : ''}>Open Buzz</button><button id="resetBuzz" type="button" ${!buzz.lockedBy && !buzz.open ? 'disabled' : ''}>Reset Buzz</button></div><form id="scoreForm">${fields}<button type="submit" ${!buzz.lockedBy ? 'disabled' : ''}>Apply Scores</button></form>`;
  bindMediaErrorHandlers(el);
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
function renderClueMedia(media, contextId) {
  const caption = media.caption ? `<figcaption>${media.caption}</figcaption>` : '';
  const alt = media.altText || 'Clue media';
  if (media.type === 'image') return `<figure class="clue-media"><img data-clue-media="${contextId}" src="${media.url}" alt="${alt}" /><div class="media-error" hidden>⚠️ Media failed to load.</div>${caption}</figure>`;
  if (media.type === 'audio') return `<figure class="clue-media"><audio data-clue-media="${contextId}" controls src="${media.url}"></audio><div class="media-error" hidden>⚠️ Media failed to load.</div>${caption}</figure>`;
  if (media.type === 'video') return `<figure class="clue-media"><video data-clue-media="${contextId}" controls src="${media.url}"></video><div class="media-error" hidden>⚠️ Media failed to load.</div>${caption}</figure>`;
  return '';
}
function bindMediaErrorHandlers(root) {
  root.querySelectorAll('[data-clue-media]').forEach((node) => {
    node.addEventListener('error', () => {
      const errorEl = node.parentElement?.querySelector('.media-error');
      if (errorEl) errorEl.hidden = false;
    }, { once: true });
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
    maxAttemptsPerClue: maxAttempts ? Number(maxAttempts) : 'unlimited',
    tieBreakerMode: fd.get('tieBreakerMode') || 'scoreFallback',
    roundMultipliers: {
      round1: Number(fd.get('round1Multiplier') || 1),
      round2: Number(fd.get('round2Multiplier') || 1)
    },
    customRoundValues: {
      round1: String(fd.get('round1Values') || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0),
      round2: String(fd.get('round2Values') || '').split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0)
    },
    wrongAnswerPenalty: {
      mode: fd.get('wrongAnswerPenaltyMode') || 'fixed',
      value: Number(fd.get('wrongAnswerPenaltyValue') || 0)
    }
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
  const now = Date.now();
  const revealedId = next.revealedClue ? `${next.round}:${next.revealedClue.answer}` : null;
  const buzzOpen = Boolean(next.buzz?.open);
  const buzzLock = next.buzz?.lockedAt || next.buzz?.lockedBy || null;
  const timerEndsAt = next.quickMoney?.timerEndsAt || null;
  const turnActive = Boolean(next.quickMoney?.turnActive);
  if (revealedId && revealedId !== previousSignal.revealed) soundboard.play('clueReveal');
  if (buzzOpen && !previousSignal.buzzOpen) soundboard.play('buzzOpen');
  if (buzzLock && buzzLock !== previousSignal.buzzLock) soundboard.play('buzzLock');
  if (turnActive && timerEndsAt && timerEndsAt !== previousSignal.timerEndsAt) soundboard.play('quickTimerStart');
  if (turnActive && timerEndsAt && timerEndsAt <= now && previousSignal.timerEndsAt && previousSignal.timerEndsAt > now) soundboard.play('quickTimerExpiry');
  previousSignal = { revealed: revealedId, buzzOpen, buzzLock, timerEndsAt, turnActive };
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


function getExportRoomCode() {
  const input = document.getElementById('exportRoomCode');
  const value = String(input?.value || state.roomCode || '').trim().toUpperCase();
  return value;
}

function triggerSessionExport(format) {
  const roomCode = getExportRoomCode();
  if (!roomCode) {
    showOperationalNotice('Enter a room code to export.', 'warning');
    return;
  }
  const url = `/host/export/${encodeURIComponent(roomCode)}?format=${encodeURIComponent(format)}`;
  window.location.assign(url);
}


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

const exportJsonButton = document.getElementById('exportJson');
if (exportJsonButton) exportJsonButton.addEventListener('click', () => triggerSessionExport('json'));
const exportCsvButton = document.getElementById('exportCsv');
if (exportCsvButton) exportCsvButton.addEventListener('click', () => triggerSessionExport('csv'));

const refreshButton = document.getElementById('refreshSessions');
if (refreshButton) refreshButton.addEventListener('click', refreshSessions);
refreshSessions();

const roomSetupForm = document.getElementById('roomSetupForm');
if (roomSetupForm) {
  roomSetupForm.addEventListener('submit', (event) => {
    const formData = new FormData(roomSetupForm);
    const parsed = Number(formData.get('topFinalists'));
    const topFinalists = Number.isInteger(parsed) && parsed >= 2 && parsed <= 5 ? parsed : 2;
    formData.set('topFinalists', String(topFinalists));
    const promptCount = Number(formData.get('quickMoneyPromptCount'));
    formData.set('quickMoneyPromptCount', String(Number.isInteger(promptCount) && promptCount >= 3 && promptCount <= 10 ? promptCount : 5));
  });
}

function createDefaultDefinitionState() {
  const mkClue = (value = 100) => ({ value, answer: '', question: '', media: null });
  const mkCategory = (name = 'New Category', base = 100) => ({ name, clues: Array.from({ length: 5 }, (_, i) => mkClue(base * (i + 1))) });
  const mkRound = (base = 100) => ({ categories: Array.from({ length: 5 }, (_, i) => mkCategory(`Category ${i + 1}`, base)) });
  return {
    metadata: { name: '' },
    round1: mkRound(100),
    round2: { categories: mkRound(200).categories, mogulMultiplier: { categoryIndex: 0, clueIndex: 0 } },
    quickMoney: { promptCount: 5, minPoints: 0, maxPoints: 1000 },
    quickMoneyPrompts: Array.from({ length: 5 }, () => '')
  };
}

let gameDefinitionState = createDefaultDefinitionState();

function moveInArray(list, from, to) {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function renderRoundEditor(containerId, roundKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const round = gameDefinitionState[roundKey];
  container.innerHTML = round.categories.map((cat, cIdx) => `
    <fieldset>
      <legend>${roundKey.toUpperCase()} Category ${cIdx + 1}</legend>
      <label>Category Name</label>
      <input data-edit="${roundKey}.category.${cIdx}.name" value="${cat.name || ''}" />
      <div class="controls">
        <button type="button" data-action="${roundKey}.category.add.${cIdx}">+ Category</button>
        <button type="button" data-action="${roundKey}.category.remove.${cIdx}" ${round.categories.length <= 1 ? 'disabled' : ''}>- Category</button>
        <button type="button" data-action="${roundKey}.category.up.${cIdx}" ${cIdx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" data-action="${roundKey}.category.down.${cIdx}" ${cIdx === round.categories.length - 1 ? 'disabled' : ''}>↓</button>
      </div>
      ${cat.clues.map((clue, rIdx) => `
        <div>
          <h5>Clue ${rIdx + 1}</h5>
          <label>Value</label><input type="number" data-edit="${roundKey}.clue.${cIdx}.${rIdx}.value" value="${clue.value || ''}" />
          <label>Answer</label><input data-edit="${roundKey}.clue.${cIdx}.${rIdx}.answer" value="${clue.answer || ''}" />
          <label>Question</label><input data-edit="${roundKey}.clue.${cIdx}.${rIdx}.question" value="${clue.question || ''}" />
          <label>Media Type</label><select data-edit="${roundKey}.clue.${cIdx}.${rIdx}.mediaType"><option value="">None</option><option value="image" ${clue.media?.type === 'image' ? 'selected' : ''}>Image</option><option value="audio" ${clue.media?.type === 'audio' ? 'selected' : ''}>Audio</option><option value="video" ${clue.media?.type === 'video' ? 'selected' : ''}>Video</option></select>
          <label>Media URL</label><input data-edit="${roundKey}.clue.${cIdx}.${rIdx}.mediaUrl" value="${clue.media?.url || ''}" placeholder="/media/example.png or https://..." />
          <label>Alt Text</label><input data-edit="${roundKey}.clue.${cIdx}.${rIdx}.mediaAltText" value="${clue.media?.altText || ''}" />
          <label>Caption</label><input data-edit="${roundKey}.clue.${cIdx}.${rIdx}.mediaCaption" value="${clue.media?.caption || ''}" />
          <input type="file" data-upload="${roundKey}.${cIdx}.${rIdx}" accept="image/*,audio/*,video/*" />
          <div class="controls">
            <button type="button" data-action="${roundKey}.clue.add.${cIdx}.${rIdx}">+ Clue</button>
            <button type="button" data-action="${roundKey}.clue.remove.${cIdx}.${rIdx}" ${cat.clues.length <= 1 ? 'disabled' : ''}>- Clue</button>
            <button type="button" data-action="${roundKey}.clue.up.${cIdx}.${rIdx}" ${rIdx === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" data-action="${roundKey}.clue.down.${cIdx}.${rIdx}" ${rIdx === cat.clues.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
        </div>`).join('')}
    </fieldset>
  `).join('');
}

function renderQuickMoneyEditor() {
  const container = document.getElementById('quickMoneyEditor');
  if (!container) return;
  container.innerHTML = gameDefinitionState.quickMoneyPrompts.map((prompt, i) => `
    <div>
      <label>Prompt ${i + 1}</label>
      <input data-edit="quick.${i}" value="${prompt || ''}" />
      <button type="button" data-action="quick.add.${i}">+ Prompt</button>
      <button type="button" data-action="quick.remove.${i}" ${gameDefinitionState.quickMoneyPrompts.length <= 1 ? 'disabled' : ''}>- Prompt</button>
      <button type="button" data-action="quick.up.${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" data-action="quick.down.${i}" ${i === gameDefinitionState.quickMoneyPrompts.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`).join('');
}

function toServerDefinitionPayload() {
  return {
    round1: { categories: gameDefinitionState.round1.categories },
    round2: {
      categories: gameDefinitionState.round2.categories,
      mogulMultiplier: {
        categoryIndex: Number(gameDefinitionState.round2.mogulMultiplier.categoryIndex || 0),
        clueIndex: Number(gameDefinitionState.round2.mogulMultiplier.clueIndex || 0)
      }
    },
    quickMoney: gameDefinitionState.quickMoney,
    quickMoneyPrompts: gameDefinitionState.quickMoneyPrompts
  };
}

function renderGameDefinitionEditor() {
  renderRoundEditor('round1Editor', 'round1');
  renderRoundEditor('round2Editor', 'round2');
  renderQuickMoneyEditor();
}

function bindGameDefinitionEditor() {
  const form = document.getElementById('gameDefinitionForm');
  if (!form) return;

  form.addEventListener('input', (event) => {
    const key = event.target.dataset.edit;
    if (!key) return;
    const value = event.target.value;
    const parts = key.split('.');
    if (parts[0] === 'quick') {
      gameDefinitionState.quickMoneyPrompts[Number(parts[1])] = value;
      return;
    }
    const [roundKey, type, a, b, field] = parts;
    if (type === 'category') gameDefinitionState[roundKey].categories[Number(a)].name = value;
    if (type === 'clue') {
      const clue = gameDefinitionState[roundKey].categories[Number(a)].clues[Number(b)];
      if (field === 'value') clue[field] = Number(value);
      else if (field === 'mediaType') clue.media = value ? { ...(clue.media || {}), type: value } : null;
      else if (field === 'mediaUrl') clue.media = value ? { ...(clue.media || {}), url: value } : (clue.media ? { ...clue.media, url: '' } : null);
      else if (field === 'mediaAltText') {
        clue.media = clue.media || { type: 'image', url: '' };
        clue.media.altText = value;
      } else if (field === 'mediaCaption') {
        clue.media = clue.media || { type: 'image', url: '' };
        clue.media.caption = value;
      }
      else clue[field] = value;
    }
  });
  form.addEventListener('change', async (event) => {
    const uploadKey = event.target.dataset.upload;
    if (!uploadKey || !event.target.files?.[0]) return;
    const errorEl = document.getElementById('gameDefinitionError');
    const body = new FormData();
    body.set('media', event.target.files[0]);
    const res = await fetch('/host/upload-media', { method: 'POST', body });
    const payload = await res.json();
    if (!res.ok) { errorEl.textContent = payload?.error?.message || 'Upload failed.'; return; }
    const [roundKey, cRaw, rRaw] = uploadKey.split('.');
    const clue = gameDefinitionState[roundKey].categories[Number(cRaw)].clues[Number(rRaw)];
    clue.media = { ...(clue.media || {}), ...payload.media };
    errorEl.textContent = `Uploaded ${event.target.files[0].name}.`;
    renderGameDefinitionEditor();
  });

  form.addEventListener('click', (event) => {
    const action = event.target.dataset.action;
    if (!action) return;
    const [scope, entity, op, a, b] = action.split('.');
    if (scope === 'quick') return;
    const indexA = Number(a);
    const indexB = Number(b);
    const round = gameDefinitionState[scope];
    if (entity === 'category') {
      if (op === 'add') round.categories.splice(indexA + 1, 0, { name: 'New Category', clues: [{ value: 100, answer: '', question: '' }] });
      if (op === 'remove') round.categories.splice(indexA, 1);
      if (op === 'up' && indexA > 0) round.categories = moveInArray(round.categories, indexA, indexA - 1);
      if (op === 'down' && indexA < round.categories.length - 1) round.categories = moveInArray(round.categories, indexA, indexA + 1);
    }
    if (entity === 'clue') {
      const clues = round.categories[indexA].clues;
      if (op === 'add') clues.splice(indexB + 1, 0, { value: 100, answer: '', question: '', media: null });
      if (op === 'remove') clues.splice(indexB, 1);
      if (op === 'up' && indexB > 0) round.categories[indexA].clues = moveInArray(clues, indexB, indexB - 1);
      if (op === 'down' && indexB < clues.length - 1) round.categories[indexA].clues = moveInArray(clues, indexB, indexB + 1);
    }
    renderGameDefinitionEditor();
  });

  form.addEventListener('click', (event) => {
    const action = event.target.dataset.action;
    if (!action || !action.startsWith('quick.')) return;
    const [, op, idxRaw] = action.split('.');
    const idx = Number(idxRaw);
    const prompts = gameDefinitionState.quickMoneyPrompts;
    if (op === 'add') prompts.splice(idx + 1, 0, '');
    if (op === 'remove') prompts.splice(idx, 1);
    if (op === 'up' && idx > 0) gameDefinitionState.quickMoneyPrompts = moveInArray(prompts, idx, idx - 1);
    if (op === 'down' && idx < prompts.length - 1) gameDefinitionState.quickMoneyPrompts = moveInArray(prompts, idx, idx + 1);
    renderGameDefinitionEditor();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorEl = document.getElementById('gameDefinitionError');
    const fd = new FormData(form);
    gameDefinitionState.metadata.name = String(fd.get('name') || '').trim();
    gameDefinitionState.round2.mogulMultiplier.categoryIndex = Number(fd.get('mogulCategoryIndex'));
    gameDefinitionState.round2.mogulMultiplier.clueIndex = Number(fd.get('mogulClueIndex'));

    try {
      await post('/host/game-definitions', { name: gameDefinitionState.metadata.name, data: toServerDefinitionPayload() });
      errorEl.textContent = 'Saved successfully.';
    } catch (error) {
      errorEl.textContent = error.message;
    }
  });

  const loadBtn = document.getElementById('loadDefinitionBtn');
  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const res = await fetch(`/host/game-definitions/${encodeURIComponent(name)}`);
      const payload = await res.json();
      if (!res.ok) {
        document.getElementById('gameDefinitionError').textContent = payload?.error?.message || 'Failed to load definition';
        return;
      }
      gameDefinitionState = { ...createDefaultDefinitionState(), ...payload.data, metadata: { name: payload.name } };
      const form = document.getElementById('gameDefinitionForm');
      if (form) { form.definitionPromptCount.value = Number(gameDefinitionState.quickMoney?.promptCount ?? 5); form.definitionMinPoints.value = Number(gameDefinitionState.quickMoney?.minPoints ?? 0); form.definitionMaxPoints.value = Number(gameDefinitionState.quickMoney?.maxPoints ?? 1000); }
      form.mogulCategoryIndex.value = String(payload.data.round2.mogulMultiplier.categoryIndex);
      form.mogulClueIndex.value = String(payload.data.round2.mogulMultiplier.clueIndex);
      renderGameDefinitionEditor();
    });
  }

  renderGameDefinitionEditor();
}

bindGameDefinitionEditor();

const soundToggle = document.getElementById('soundEnabledToggle');
if (soundToggle) {
  const current = localStorage.getItem('gameshow:soundEnabled') !== 'false';
  soundToggle.checked = current;
  soundToggle.addEventListener('change', () => soundboard.setEnabled(soundToggle.checked));
}

loadTranslations('host');
