let socket = null;
let currentState = null;
let playerStatusMessage = '';

const joinCodeInput = document.getElementById('joinCode');
const roomCodeInput = document.getElementById('roomCode');
const connectButton = document.getElementById('connectButton');
const playerConnectionStatus = document.getElementById('playerConnectionStatus');
const selectedPlayer = document.getElementById('selectedPlayer');
const playerPhase = document.getElementById('playerPhase');
const playerClue = document.getElementById('playerClue');
const buzzButton = document.getElementById('buzzButton');
const buzzInfo = document.getElementById('buzzInfo');

async function fetchState() {
  const roomCode = (roomCodeInput.value || '').trim().toUpperCase();
  const response = await fetch(`/state?room=${encodeURIComponent(roomCode)}`);
  return response.json();
}

function setConnectionStatus(text, online) {
  playerConnectionStatus.textContent = text;
  playerConnectionStatus.dataset.online = online ? 'true' : 'false';
}

function renderState(state) {
  currentState = state;
  const roomCode = (roomCodeInput.value || '').trim().toUpperCase();
  const joinCode = (joinCodeInput.value || '').trim().toUpperCase();
  if (joinCode && state.joinCodes) {
    const matchedEntry = Object.entries(state.joinCodes).find(([, value]) => value.code === joinCode);
    selectedPlayer.textContent = matchedEntry ? matchedEntry[0] : '—';
  }
  playerPhase.textContent = `Phase: ${state.phase} | Round ${state.round}`;
  playerClue.textContent = state.revealedClue
    ? `Current clue: ${state.revealedClue.answer}`
    : 'Current clue: None';

  const buzz = state.buzz || { open: false, lockedBy: null };
  const canBuzz = Boolean(state.revealedClue) && state.phase !== 'quickMoney' && buzz.open && !buzz.lockedBy;
  buzzButton.disabled = !canBuzz;
  if (!state.revealedClue || state.phase === 'quickMoney') {
    buzzInfo.textContent = 'Buzzing is disabled until a clue is revealed.';
  } else if (buzz.lockedBy) {
    buzzInfo.textContent = `Buzz locked by ${buzz.lockedBy}.`;
  } else if (!buzz.open) {
    buzzInfo.textContent = 'Waiting for host to open buzzing.';
  } else {
    buzzInfo.textContent = 'Buzzing is enabled for this clue.';
  }
  if (playerStatusMessage) {
    buzzInfo.textContent = `${buzzInfo.textContent} ${playerStatusMessage}`;
  }
}

function connectAsPlayer() {
  const roomCode = (roomCodeInput.value || '').trim().toUpperCase();
  const joinCode = (joinCodeInput.value || '').trim().toUpperCase();
  if (!joinCode || !roomCode) return;

  if (socket) {
    socket.disconnect();
  }

  socket = io({ query: { role: 'player', roomCode, joinCode } });
  selectedPlayer.textContent = 'Authenticating...';

  socket.on('connect', () => setConnectionStatus('Connected', true));
  socket.on('disconnect', () => setConnectionStatus('Disconnected', false));
  socket.on('auth:rejected', ({ reason }) => {
    selectedPlayer.textContent = '—';
    setConnectionStatus(`Rejected: ${reason}`, false);
  });
  socket.on('session:taken-over', ({ playerName }) => {
    setConnectionStatus(`Disconnected: session taken over for ${playerName}`, false);
  });
  socket.on('state:update', (state) => renderState(state));
  socket.on('player:status', ({ kind, playerName, holdMs }) => {
    if (kind === 'locked-winner-disconnected') {
      const holdSeconds = Math.floor(Number(holdMs || 0) / 1000);
      playerStatusMessage = `Your lock was retained for ${holdSeconds}s while disconnected. Reconnect quickly or ask host to reset manually.`;
    } else if (kind === 'lock-restored') {
      playerStatusMessage = `Reconnected as ${playerName}. Your buzz lock is still active; wait for host scoring.`;
    } else if (kind === 'eligibility-restored') {
      playerStatusMessage = `Reconnected as ${playerName}. Buzz is open and your eligibility is restored.`;
    } else {
      playerStatusMessage = '';
    }
    if (currentState) renderState(currentState);
  });
}

connectButton.addEventListener('click', connectAsPlayer);
buzzButton.addEventListener('click', () => {
  if (!socket || !socket.connected || buzzButton.disabled) return;
  socket.emit('player:buzz', { at: Date.now() });
});

const params = new URLSearchParams(window.location.search);
const initialCode = params.get('code');
const initialRoom = params.get('room');
if (initialRoom) roomCodeInput.value = initialRoom.toUpperCase();
if (initialCode) {
  joinCodeInput.value = initialCode.toUpperCase();
}

fetchState().then((state) => {
  renderState(state);
  if (initialCode) connectAsPlayer();
}).catch(() => {
  setConnectionStatus('Unable to load state', false);
});
