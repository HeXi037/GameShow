let socket = null;
let currentState = null;

const joinCodeInput = document.getElementById('joinCode');
const connectButton = document.getElementById('connectButton');
const playerConnectionStatus = document.getElementById('playerConnectionStatus');
const selectedPlayer = document.getElementById('selectedPlayer');
const playerPhase = document.getElementById('playerPhase');
const playerClue = document.getElementById('playerClue');
const buzzButton = document.getElementById('buzzButton');
const buzzInfo = document.getElementById('buzzInfo');

async function fetchState() {
  const response = await fetch('/state');
  return response.json();
}

function setConnectionStatus(text, online) {
  playerConnectionStatus.textContent = text;
  playerConnectionStatus.dataset.online = online ? 'true' : 'false';
}

function renderState(state) {
  currentState = state;
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
}

function connectAsPlayer() {
  const joinCode = (joinCodeInput.value || '').trim().toUpperCase();
  if (!joinCode) return;

  if (socket) {
    socket.disconnect();
  }

  socket = io({ query: { role: 'player', joinCode } });
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
}

connectButton.addEventListener('click', connectAsPlayer);
buzzButton.addEventListener('click', () => {
  if (!socket || !socket.connected || buzzButton.disabled) return;
  socket.emit('player:buzz', { at: Date.now() });
});

const initialCode = new URLSearchParams(window.location.search).get('code');
if (initialCode) {
  joinCodeInput.value = initialCode.toUpperCase();
}

fetchState().then((state) => {
  renderState(state);
  if (initialCode) connectAsPlayer();
}).catch(() => {
  setConnectionStatus('Unable to load state', false);
});
