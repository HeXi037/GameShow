let socket = null;
let currentState = null;

const playerNameSelect = document.getElementById('playerName');
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

function renderPlayerOptions(state) {
  const players = state.players || [];
  playerNameSelect.innerHTML = players.map((p) => `<option value="${p.name}">${p.name}</option>`).join('');
}

function setConnectionStatus(text, online) {
  playerConnectionStatus.textContent = text;
  playerConnectionStatus.dataset.online = online ? 'true' : 'false';
}

function renderState(state) {
  currentState = state;
  playerPhase.textContent = `Phase: ${state.phase} | Round ${state.round}`;
  playerClue.textContent = state.revealedClue
    ? `Current clue: ${state.revealedClue.answer}`
    : 'Current clue: None';

  const canBuzz = Boolean(state.revealedClue) && state.phase !== 'quickMoney';
  buzzButton.disabled = !canBuzz;
  buzzInfo.textContent = canBuzz
    ? 'Buzzing is enabled for this clue.'
    : 'Buzzing is disabled until a clue is revealed.';

  renderPlayerOptions(state);
}

function connectAsPlayer() {
  const playerName = playerNameSelect.value;
  if (!playerName) return;

  if (socket) {
    socket.disconnect();
  }

  socket = io({ query: { role: 'player', playerName } });
  selectedPlayer.textContent = playerName;

  socket.on('connect', () => setConnectionStatus('Connected', true));
  socket.on('disconnect', () => setConnectionStatus('Disconnected', false));
  socket.on('state:update', (state) => renderState(state));
}

connectButton.addEventListener('click', connectAsPlayer);
buzzButton.addEventListener('click', () => {
  if (!socket || !socket.connected || buzzButton.disabled) return;
  socket.emit('player:buzz', { playerName: playerNameSelect.value, at: Date.now() });
});

fetchState().then(renderState).catch(() => {
  setConnectionStatus('Unable to load state', false);
});
