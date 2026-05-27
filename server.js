const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const session = require('express-session');
const { Server } = require('socket.io');
const { initializeGame, selectClue, applyMultiplier, advanceQuickMoney, openBuzz, resetBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig, normalizeConfig, getRoundBoard, startQuickMoneyTurn } = require('./src/gameState');
const { buildSessionConfig } = require('./src/envConfig');
const { saveSession, loadSession, listSessions, archiveSession } = require('./src/sessionStore');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const PORT = process.env.PORT || 3000;
const isDevelopment = process.env.NODE_ENV === 'development';
const HOST_PASSWORD = process.env.HOST_PASSWORD || (isDevelopment ? 'mogulhost' : null);
if (!HOST_PASSWORD) throw new Error('HOST_PASSWORD environment variable is required when NODE_ENV is not development.');
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session(buildSessionConfig(process.env)));

const emptyState = () => ({ phase: 'setup', round: 1, players: [], boardData: null, revealedClue: null, buzz: null, quickMoney: { finalists: [], currentFinalistIndex: 0, promptIndex: 0, turnActive: false, answers: {}, timerEndsAt: null, active: false, completed: false, topFinalists: 2 }, config: normalizeConfig() });
const mkRoom = (roomCode) => ({ roomCode, gameState: emptyState(), connectedClients: new Map(), joinIdentity: { codesByPlayer: new Map(), playerByCode: new Map(), activeSocketByPlayer: new Map() } });
const getRoom = (roomCode) => rooms.get(String(roomCode || '').trim().toUpperCase()) || null;
function getOrCreateRoom(roomCode) { const key = String(roomCode || '').trim().toUpperCase(); if (!key) return null; if (!rooms.has(key)) rooms.set(key, mkRoom(key)); return rooms.get(key); }
const activeRoomCode = (req) => String(req.body.roomCode || req.query.room || req.session.activeRoomCode || '').trim().toUpperCase();

function resetJoinIdentity(room, playerNames) {
  room.joinIdentity = { codesByPlayer: new Map(), playerByCode: new Map(), activeSocketByPlayer: new Map() };
  playerNames.forEach((name, i) => { const code = `P${i + 1}${room.roomCode}`; room.joinIdentity.codesByPlayer.set(name, code); room.joinIdentity.playerByCode.set(code, name); });
}
function publicState(room) { return { roomCode: room.roomCode, phase: room.gameState.phase, round: room.gameState.round, players: room.gameState.players, board: room.gameState.boardData ? getRoundBoard(room.gameState) : null, revealedClue: room.gameState.revealedClue, buzz: room.gameState.buzz, config: room.gameState.config, quickMoneyPrompts: room.gameState.boardData?.quickMoneyPrompts || [], quickMoney: room.gameState.quickMoney, joinCodes: {} }; }
function emitRoomState(room) { io.to(room.roomCode).emit('state:update', publicState(room)); }
const persistRoom = (room) => saveSession(room.roomCode, room.gameState);

function loadGameData(filePath) { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
function initializeBoardState(data) { ['round1', 'round2'].forEach((roundKey) => data[roundKey].categories.forEach((category) => category.clues.forEach((clue) => { clue.used = false; }))); }
function safeGameDefinitionName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('Game definition name is required.');
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) throw new Error('Game definition name may only include letters, numbers, underscores, and hyphens.');
  return trimmed;
}
function resolveDataFileByName(name) {
  const safeName = safeGameDefinitionName(name);
  return path.join(__dirname, 'data', `${safeName}.json`);
}
function validateGameData(data) {
  const ensureRound = (roundName) => {
    const round = data?.[roundName];
    if (!round || !Array.isArray(round.categories) || round.categories.length !== 5) throw new Error(`${roundName} must include exactly 5 categories.`);
    round.categories.forEach((category, categoryIndex) => {
      if (!category || typeof category.name !== 'string' || !category.name.trim()) throw new Error(`${roundName}.categories[${categoryIndex}].name is required.`);
      if (!Array.isArray(category.clues) || category.clues.length !== 5) throw new Error(`${roundName}.categories[${categoryIndex}] must include exactly 5 clues.`);
      category.clues.forEach((clue, clueIndex) => {
        if (!Number.isFinite(Number(clue?.value))) throw new Error(`${roundName}.categories[${categoryIndex}].clues[${clueIndex}].value must be numeric.`);
        if (typeof clue?.answer !== 'string' || !clue.answer.trim()) throw new Error(`${roundName}.categories[${categoryIndex}].clues[${clueIndex}].answer is required.`);
        if (typeof clue?.question !== 'string' || !clue.question.trim()) throw new Error(`${roundName}.categories[${categoryIndex}].clues[${clueIndex}].question is required.`);
      });
    });
  };

  ensureRound('round1');
  ensureRound('round2');

  const mm = data?.round2?.mogulMultiplier;
  if (!mm || !Number.isInteger(Number(mm.categoryIndex)) || !Number.isInteger(Number(mm.clueIndex))) {
    throw new Error('round2.mogulMultiplier must include integer categoryIndex and clueIndex.');
  }
  const catIndex = Number(mm.categoryIndex);
  const clueIndex = Number(mm.clueIndex);
  if (catIndex < 0 || catIndex > 4 || clueIndex < 0 || clueIndex > 4) throw new Error('round2.mogulMultiplier coordinates must be between 0 and 4.');

  if (!Array.isArray(data?.quickMoneyPrompts) || data.quickMoneyPrompts.length !== 5) throw new Error('quickMoneyPrompts must include exactly 5 prompts.');
  data.quickMoneyPrompts.forEach((prompt, i) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`quickMoneyPrompts[${i}] is required.`);
  });
  return true;
}
function requireHost(req, res, next) { if (!req.session.isHost) return res.redirect('/host/login'); next(); }
function getHostRoom(req, res) { const code = activeRoomCode(req); const room = getRoom(code); if (!room) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Room not found.' } }); return null; } return room; }

app.get('/', (req, res) => res.render('index'));
app.get('/join', (req, res) => res.render('join'));
app.get('/host/login', (req, res) => res.render('login', { error: null }));
app.post('/host/login', (req, res) => { if (req.body.password === HOST_PASSWORD) { req.session.isHost = true; return res.redirect('/host'); } return res.status(401).render('login', { error: 'Invalid password.' }); });
app.get('/host', requireHost, (req, res) => res.render('host', { state: getRoom(activeRoomCode(req)) ? publicState(getRoom(activeRoomCode(req))) : null, sessions: listSessions() }));
app.get('/host/sessions', requireHost, (req, res) => res.json({ sessions: listSessions() }));
app.post('/host/resume', requireHost, (req, res) => { const saved = loadSession(req.body.roomCode); if (!saved) return res.status(404).json({ error: 'Session not found.' }); const room = getOrCreateRoom(saved.roomCode); room.gameState = saved.state; req.session.activeRoomCode = saved.roomCode; emitRoomState(room); res.json({ ok: true }); });
app.post('/host/archive', requireHost, (req, res) => res.json({ ok: archiveSession(req.body.roomCode) }));

app.post('/host/game-definitions', requireHost, (req, res) => {
  try {
    const name = safeGameDefinitionName(req.body?.name);
    const data = req.body?.data;
    validateGameData(data);
    const filePath = resolveDataFileByName(name);
    if (fs.existsSync(filePath)) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Game definition already exists.' } });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    res.status(201).json({ ok: true, name, file: path.basename(filePath) });
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
  }
});

app.get('/host/game-definitions/:name', requireHost, (req, res) => {
  try {
    const filePath = resolveDataFileByName(req.params.name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Game definition not found.' } });
    const data = loadGameData(filePath);
    validateGameData(data);
    res.json({ name: safeGameDefinitionName(req.params.name), data });
  } catch (error) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
  }
});

app.post('/host/setup', requireHost, upload.single('boardFile'), (req, res) => {
  try {
    const roomCode = String(req.body.roomCode || '').trim().toUpperCase();
    const names = String(req.body.playerNames || '').split(',').map((n) => n.trim()).filter(Boolean);
    const room = getOrCreateRoom(roomCode);
    const filePath = req.file ? req.file.path : path.join(__dirname, 'data', req.body.localDataFile || 'sample-game.json');
    const boardData = loadGameData(filePath); initializeBoardState(boardData);
    room.gameState = initializeGame({ playerNames: names, boardData, topFinalists: 2 });
    resetJoinIdentity(room, names);
    req.session.activeRoomCode = roomCode;
    persistRoom(room); emitRoomState(room);
    res.redirect('/host');
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function hostAction(req, res, action) { try { const room = getHostRoom(req, res); if (!room) return; action(room); persistRoom(room); emitRoomState(room); res.sendStatus(200); } catch (e) { res.status(400).json({ error: { message: e.message } }); } }
app.post('/host/select-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const out = selectClue(room.gameState, Number(req.body.categoryIndex), Number(req.body.clueIndex)); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/open-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const out = openBuzz(room.gameState); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/reset-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const out = resetBuzz(room.gameState); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/score-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const out = applyScoreAndBuzzRules(room.gameState, req.body.playerResults || {}); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/config', requireHost, (req, res) => hostAction(req, res, (room) => { room.gameState = updateConfig(room.gameState, req.body || {}); }));
app.post('/host/mogul-multiplier', requireHost, (req, res) => hostAction(req, res, (room) => { const out = applyMultiplier(room.gameState, req.body); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/quick-money/start-turn', requireHost, (req, res) => hostAction(req, res, (room) => { const out = startQuickMoneyTurn(room.gameState, Number(req.body.seconds || 20)); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/quick-money/submit', requireHost, (req, res) => hostAction(req, res, (room) => { const out = advanceQuickMoney(room.gameState, req.body); if (out.error) throw new Error(out.error); room.gameState = out.state; }));

io.on('connection', (socket) => {
  const room = getRoom(socket.handshake.query?.roomCode);
  if (!room) return socket.disconnect(true);
  socket.join(room.roomCode);
  socket.on('player:buzz', () => {
    const result = lockBuzz(room.gameState, socket.handshake.query?.playerName, Date.now());
    if (result.error) return;
    room.gameState = result.state; persistRoom(room); emitRoomState(room);
  });
});

for (const sessionMeta of listSessions().filter((s) => !s.archived)) {
  const saved = loadSession(sessionMeta.roomCode);
  if (saved?.state) {
    const room = getOrCreateRoom(saved.roomCode);
    room.gameState = saved.state;
  }
}

if (require.main === module) server.listen(PORT, () => console.log(`Running on ${PORT}`));
module.exports = { app, server, io, __testHooks: { rooms, getOrCreateRoom, publicState } };
