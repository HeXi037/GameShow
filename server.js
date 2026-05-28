const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const session = require('express-session');
const { Server } = require('socket.io');
const { initializeGame, selectClue, applyMultiplier, advanceQuickMoney, openBuzz, resetBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig, normalizeConfig, getRoundBoard, startQuickMoneyTurn } = require('./src/gameState');
const { buildSessionConfig } = require('./src/envConfig');
const { saveSession, loadSession, listSessions, archiveSession, getSessionExportJSON, getSessionExportCSV, getLeaderboard } = require('./src/sessionStore');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const PORT = process.env.PORT || 3000;
const isDevelopment = process.env.NODE_ENV === 'development';
const HOST_PASSWORD = process.env.HOST_PASSWORD || (isDevelopment ? 'mogulhost' : null);
if (!HOST_PASSWORD) throw new Error('HOST_PASSWORD environment variable is required when NODE_ENV is not development.');
const upload = multer({ dest: path.join(__dirname, 'uploads') });
const mediaDir = path.join(__dirname, 'public', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, mediaDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
      const base = path.basename(file.originalname || 'upload', ext).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'upload';
      cb(null, `${Date.now()}-${base}${ext || ''}`);
    }
  }),
  limits: { fileSize: MEDIA_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = /^image\/|^audio\/|^video\//.test(file.mimetype || '');
    if (!allowed) return cb(new Error('Unsupported media type. Allowed: image/audio/video.'));
    cb(null, true);
  }
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session(buildSessionConfig(process.env)));

const emptyState = () => ({ phase: 'setup', round: 1, players: [], boardData: null, revealedClue: null, buzz: null, quickMoney: { finalists: [], currentFinalistIndex: 0, promptIndex: 0, turnActive: false, answers: {}, timerEndsAt: null, active: false, completed: false, topFinalists: 2, promptCount: 5, minPoints: 0, maxPoints: 1000 }, config: normalizeConfig() });
const mkRoom = (roomCode) => ({ roomCode, gameState: emptyState(), connectedClients: new Map(), joinIdentity: { codesByPlayer: new Map(), playerByCode: new Map(), activeSocketByPlayer: new Map() } });
const getRoom = (roomCode) => rooms.get(String(roomCode || '').trim().toUpperCase()) || null;
function getOrCreateRoom(roomCode) { const key = String(roomCode || '').trim().toUpperCase(); if (!key) return null; if (!rooms.has(key)) rooms.set(key, mkRoom(key)); return rooms.get(key); }
const activeRoomCode = (req) => String(req.body.roomCode || req.query.room || req.session.activeRoomCode || '').trim().toUpperCase();

function resetJoinIdentity(room, playerNames) {
  room.joinIdentity = { codesByPlayer: new Map(), playerByCode: new Map(), activeSocketByPlayer: new Map() };
  playerNames.forEach((name, i) => { const code = `P${i + 1}${room.roomCode}`; room.joinIdentity.codesByPlayer.set(name, code); room.joinIdentity.playerByCode.set(code, name); });
}
function publicState(room) { return { roomCode: room.roomCode, phase: room.gameState.phase, round: room.gameState.round, players: room.gameState.players, board: room.gameState.boardData ? getRoundBoard(room.gameState) : null, revealedClue: room.gameState.revealedClue, buzz: room.gameState.buzz, config: room.gameState.config, quickMoneyPrompts: room.gameState.boardData?.quickMoneyPrompts || [], quickMoney: room.gameState.quickMoney, answerCapture: room.gameState.answerCapture || { clueKey: null, byPlayer: {} }, joinCodes: {} }; }
function emitRoomState(room) { io.to(room.roomCode).emit('state:update', publicState(room)); }
const persistRoom = (room) => saveSession(room.roomCode, room.gameState);

function activeClueKey(state) {
  const clue = state?.revealedClue;
  if (!clue) return null;
  return `r${Number(state.round || 0)}:c${Number(clue.categoryIndex)}:q${Number(clue.clueIndex)}`;
}

function ensureAnswerCapture(state) {
  if (!state.answerCapture || typeof state.answerCapture !== 'object') {
    state.answerCapture = { clueKey: null, byPlayer: {} };
  }
  if (!state.archivedAnswers || !Array.isArray(state.archivedAnswers)) {
    state.archivedAnswers = [];
  }
  return state;
}

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
function parseQuickMoneyConfig(rawConfig = {}) {
  const promptCount = Number(rawConfig.promptCount ?? 5);
  const minPoints = Number(rawConfig.minPoints ?? 0);
  const maxPoints = Number(rawConfig.maxPoints ?? 1000);
  if (!Number.isInteger(promptCount) || promptCount < 3 || promptCount > 10) throw new Error('quickMoney.promptCount must be an integer between 3 and 10.');
  if (!Number.isInteger(minPoints) || !Number.isInteger(maxPoints) || minPoints >= maxPoints) throw new Error('quickMoney.minPoints and quickMoney.maxPoints must be integers with minPoints < maxPoints.');
  return { promptCount, minPoints, maxPoints };
}

function validateGameData(data) {
  const ensureMedia = (clue, pathPrefix) => {
    if (!Object.hasOwn(clue, 'media') || clue.media == null) return;
    if (typeof clue.media !== 'object' || Array.isArray(clue.media)) throw new Error(`${pathPrefix}.media must be an object when provided.`);
    const { type, url, altText, caption } = clue.media;
    if (!['image', 'audio', 'video'].includes(type)) throw new Error(`${pathPrefix}.media.type must be one of image, audio, or video.`);
    if (typeof url !== 'string' || !url.trim()) throw new Error(`${pathPrefix}.media.url is required.`);
    if (altText != null && (typeof altText !== 'string' || !altText.trim())) throw new Error(`${pathPrefix}.media.altText must be a non-empty string when provided.`);
    if (caption != null && (typeof caption !== 'string' || !caption.trim())) throw new Error(`${pathPrefix}.media.caption must be a non-empty string when provided.`);
  };
  const ensureRound = (roundName) => {
    const round = data?.[roundName];
    if (!round || !Array.isArray(round.categories) || round.categories.length !== 5) throw new Error(`${roundName} must include exactly 5 categories.`);
    round.categories.forEach((category, categoryIndex) => {
      if (!category || typeof category.name !== 'string' || !category.name.trim()) throw new Error(`${roundName}.categories[${categoryIndex}].name is required.`);
      if (!Array.isArray(category.clues) || category.clues.length !== 5) throw new Error(`${roundName}.categories[${categoryIndex}] must include exactly 5 clues.`);
      category.clues.forEach((clue, clueIndex) => {
        ensureMedia(clue, `${roundName}.categories[${categoryIndex}].clues[${clueIndex}]`);
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

  const quickMoneyConfig = parseQuickMoneyConfig(data?.quickMoney || {});
  if (!Array.isArray(data?.quickMoneyPrompts) || data.quickMoneyPrompts.length !== quickMoneyConfig.promptCount) throw new Error(`quickMoneyPrompts must include exactly ${quickMoneyConfig.promptCount} prompts.`);
  data.quickMoneyPrompts.forEach((prompt, i) => {
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error(`quickMoneyPrompts[${i}] is required.`);
  });
  data.quickMoney = quickMoneyConfig;
  return true;
}
function requireHost(req, res, next) { if (!req.session.isHost) return res.redirect('/host/login'); next(); }
function getHostRoom(req, res) { const code = activeRoomCode(req); const room = getRoom(code); if (!room) { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Room not found.' } }); return null; } return room; }

app.get('/', (req, res) => res.render('index'));
app.get('/join', (req, res) => res.render('join'));

app.get('/leaderboard', (req, res) => {
  if ((req.headers.accept || '').includes('application/json') || req.query.format === 'json') {
    const sortBy = ['wins', 'averageScore', 'totalGames', 'fastestBuzz'].includes(String(req.query.sortBy)) ? String(req.query.sortBy) : 'wins';
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const offset = Number(req.query.offset || 0);
    const limit = Number(req.query.limit || 20);
    return res.json({ sortBy, order, offset: Math.max(0, offset), limit: Math.max(1, Math.min(200, limit)), ...getLeaderboard(sortBy, order, offset, limit) });
  }
  return res.render('leaderboard');
});
app.get('/host/login', (req, res) => res.render('login', { error: null }));
app.post('/host/login', (req, res) => { if (req.body.password === HOST_PASSWORD) { req.session.isHost = true; return res.redirect('/host'); } return res.status(401).render('login', { error: 'Invalid password.' }); });
app.get('/host', requireHost, (req, res) => res.render('host', { state: getRoom(activeRoomCode(req)) ? publicState(getRoom(activeRoomCode(req))) : null, sessions: listSessions() }));
app.get('/host/sessions', requireHost, (req, res) => res.json({ sessions: listSessions() }));
app.post('/host/resume', requireHost, (req, res) => { const saved = loadSession(req.body.roomCode); if (!saved) return res.status(404).json({ error: 'Session not found.' }); const room = getOrCreateRoom(saved.roomCode); room.gameState = saved.state; req.session.activeRoomCode = saved.roomCode; emitRoomState(room); res.json({ ok: true }); });
app.post('/host/archive', requireHost, (req, res) => res.json({ ok: archiveSession(req.body.roomCode) }));


app.get('/host/export/:roomCode', requireHost, (req, res) => {
  const requestedRoomCode = String(req.params.roomCode || '').trim().toUpperCase();
  const sessionRoomCode = String(req.session.activeRoomCode || '').trim().toUpperCase();
  if (!sessionRoomCode || requestedRoomCode !== sessionRoomCode) {
    return res.status(403).json({ error: 'Unauthorized host context.' });
  }

  const format = String(req.query.format || 'json').toLowerCase();
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === 'csv') {
    const csvPayload = getSessionExportCSV(requestedRoomCode);
    if (!csvPayload) return res.status(404).json({ error: 'Session not found.' });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${requestedRoomCode}-${stamp}.csv"`);
    return res.send(csvPayload);
  }

  const jsonPayload = getSessionExportJSON(requestedRoomCode);
  if (!jsonPayload) return res.status(404).json({ error: 'Session not found.' });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${requestedRoomCode}-${stamp}.json"`);
  return res.send(JSON.stringify(jsonPayload, null, 2));
});


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

app.post('/host/upload-media', requireHost, (req, res) => {
  mediaUpload.single('media')(req, res, (error) => {
    if (error) {
      if (error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `File too large. Maximum ${MEDIA_MAX_BYTES} bytes.` } });
      return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: error.message } });
    }
    if (!req.file) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'No media file uploaded.' } });
    const url = `/media/${req.file.filename}`;
    let type = 'image';
    if (req.file.mimetype.startsWith('audio/')) type = 'audio';
    if (req.file.mimetype.startsWith('video/')) type = 'video';
    return res.status(201).json({ ok: true, media: { type, url } });
  });
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
    const requestBody = req.body || {};
    const roomCode = String(requestBody.roomCode || '').trim().toUpperCase();
    const names = String(requestBody.playerNames || '').split(',').map((n) => n.trim()).filter(Boolean);
    const parsedTopFinalists = parseTopFinalists(requestBody.topFinalists ?? 2);
    const parsedQuickMoneyConfig = parseQuickMoneyConfig({
      promptCount: requestBody.quickMoneyPromptCount,
      minPoints: requestBody.quickMoneyMinPoints,
      maxPoints: requestBody.quickMoneyMaxPoints
    });
    if (parsedTopFinalists.error) return res.status(400).json({ error: parsedTopFinalists.error });
    const room = getOrCreateRoom(roomCode);
    const filePath = req.file ? req.file.path : path.join(__dirname, 'data', requestBody.localDataFile || 'sample-game.json');
    const boardData = loadGameData(filePath); initializeBoardState(boardData);
    room.gameState = initializeGame({ playerNames: names, boardData, topFinalists: parsedTopFinalists.value });
    room.gameState = initializeQuickMoney(room.gameState, parsedTopFinalists.value, parsedQuickMoneyConfig);
    ensureAnswerCapture(room.gameState);
    resetJoinIdentity(room, names);
    req.session.activeRoomCode = roomCode;
    persistRoom(room); emitRoomState(room);
    res.redirect('/host');
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function hostAction(req, res, action) { try { const room = getHostRoom(req, res); if (!room) return; ensureAnswerCapture(room.gameState); action(room); persistRoom(room); emitRoomState(room); res.sendStatus(200); } catch (e) { res.status(400).json({ error: { message: e.message } }); } }
app.post('/host/select-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const out = selectClue(room.gameState, Number(req.body.categoryIndex), Number(req.body.clueIndex)); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/open-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const out = openBuzz(room.gameState); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/reset-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const out = resetBuzz(room.gameState); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/score-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const out = applyScoreAndBuzzRules(room.gameState, req.body.playerResults || {}); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/config', requireHost, (req, res) => hostAction(req, res, (room) => { room.gameState = updateConfig(room.gameState, req.body || {}); }));
app.post('/host/mogul-multiplier', requireHost, (req, res) => hostAction(req, res, (room) => { const out = applyMultiplier(room.gameState, req.body); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/quick-money/start-turn', requireHost, (req, res) => hostAction(req, res, (room) => { const out = startQuickMoneyTurn(room.gameState, Number(req.body.seconds || 20)); if (out.error) throw new Error(out.error); room.gameState = out.state; }));
app.post('/host/quick-money/submit', requireHost, (req, res) => hostAction(req, res, (room) => { const out = advanceQuickMoney(room.gameState, req.body); if (out.error) throw new Error(out.error); room.gameState = out.state; }));

io.on('connection', (socket) => {
  const role = String(socket.handshake.query?.role || '').trim();
  const room = getRoom(socket.handshake.query?.roomCode);
  if (!room) return socket.disconnect(true);
  ensureAnswerCapture(room.gameState);
  socket.join(room.roomCode);

  let playerName = null;
  if (role === 'player') {
    const joinCode = String(socket.handshake.query?.joinCode || '').trim().toUpperCase();
    playerName = room.joinIdentity?.playerByCode?.get(joinCode) || null;
    if (!playerName) {
      socket.emit('auth:rejected', { reason: 'Invalid join code.' });
      return socket.disconnect(true);
    }
    const current = room.joinIdentity.activeSocketByPlayer.get(playerName);
    if (current && current !== socket.id) {
      io.to(current).emit('session:taken-over', { playerName });
      const prev = io.sockets.sockets.get(current);
      if (prev) prev.disconnect(true);
    }
    room.joinIdentity.activeSocketByPlayer.set(playerName, socket.id);
    socket.data.playerName = playerName;
  }

  socket.emit('state:update', publicState(room));

  socket.on('disconnect', () => {
    if (role === 'player' && playerName && room.joinIdentity.activeSocketByPlayer.get(playerName) === socket.id) {
      room.joinIdentity.activeSocketByPlayer.delete(playerName);
    }
  });

  socket.on('player:buzz', ({ at } = {}) => {
    if (role !== 'player' || !socket.data.playerName) return;
    const result = lockBuzz(room.gameState, socket.data.playerName, Number(at) || Date.now());
    if (result.error) return;
    room.gameState = result.state;
    const key = activeClueKey(room.gameState);
    if (key && room.gameState.answerCapture.clueKey !== key) {
      room.gameState.answerCapture = { clueKey: key, byPlayer: {} };
    }
    persistRoom(room); emitRoomState(room);
  });

  socket.on('player:answer', (payload = {}) => {
    if (role !== 'player' || !socket.data.playerName) return;
    const clueKey = activeClueKey(room.gameState);
    if (!clueKey || !room.gameState.buzz?.lockedBy || room.gameState.buzz.lockedBy !== socket.data.playerName) {
      return socket.emit('player:answer:rejected', { reason: 'Not eligible to submit answer.' });
    }
    if (room.gameState.answerCapture.clueKey !== clueKey) {
      room.gameState.answerCapture = { clueKey, byPlayer: {} };
    }
    if (room.gameState.answerCapture.byPlayer[socket.data.playerName]) {
      return socket.emit('player:answer:rejected', { reason: 'Answer already submitted for this lock.' });
    }
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    if (!answer) return socket.emit('player:answer:rejected', { reason: 'Answer is required.' });
    const submittedAt = Number(payload.submittedAt || Date.now());
    const record = { roomCode: room.roomCode, playerName: socket.data.playerName, clueKey, answer, submittedAt };
    room.gameState.answerCapture.byPlayer[socket.data.playerName] = record;
    room.gameState.archivedAnswers.push(record);
    persistRoom(room); emitRoomState(room);
    socket.emit('player:answer:accepted', { clueKey, submittedAt });
  });
});

for (const sessionMeta of listSessions().filter((s) => !s.archived)) {
  const saved = loadSession(sessionMeta.roomCode);
  if (saved?.state) {
    const room = getOrCreateRoom(saved.roomCode);
    room.gameState = saved.state;
    ensureAnswerCapture(room.gameState);
  }
}

if (require.main === module) server.listen(PORT, () => console.log(`Running on ${PORT}`));
module.exports = { app, server, io, __testHooks: { rooms, getOrCreateRoom, publicState } };
