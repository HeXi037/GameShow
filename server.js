const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const session = require('express-session');
const { Server } = require('socket.io');
const { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, openBuzz, resetBuzz, lockBuzz, applyScoreAndBuzzRules, updateConfig, normalizeConfig, getRoundBoard, startQuickMoneyTurn } = require('./src/gameState');
const { buildSessionConfig } = require('./src/envConfig');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

const PORT = process.env.PORT || 3000;
const QUICK_MONEY_TURN_SECONDS_MIN = 5;
const QUICK_MONEY_TURN_SECONDS_MAX = 120;
const LOCK_HOLD_ON_DISCONNECT_MS = 10000;
const isDevelopment = process.env.NODE_ENV === 'development';
const HOST_PASSWORD = process.env.HOST_PASSWORD || (isDevelopment ? 'mogulhost' : null);
if (!HOST_PASSWORD) throw new Error('HOST_PASSWORD environment variable is required when NODE_ENV is not development.');
const upload = multer({ dest: path.join(__dirname, 'uploads') });

const HOST_ERROR_CODES = Object.freeze({ clueNotFound: 'CLUE_NOT_FOUND', buzzNotLocked: 'BUZZ_NOT_LOCKED', invalidWager: 'INVALID_WAGER', invalidGameData: 'INVALID_GAME_DATA', invalidRequest: 'INVALID_REQUEST', quickMoneyInactive: 'QUICK_MONEY_INACTIVE', quickMoneyComplete: 'QUICK_MONEY_COMPLETE', multiplierInactive: 'MULTIPLIER_INACTIVE' });
function sendHostError(res, status, code, message) { return res.status(status).json({ error: { code, message } }); }

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);
app.use(session(buildSessionConfig(process.env)));

const emptyState = () => ({ phase: 'setup', round: 1, players: [], boardData: null, revealedClue: null, buzz: null, quickMoney: { finalists: [], currentFinalistIndex: 0, promptIndex: 0, turnActive: false, answers: {}, timerEndsAt: null, active: false, completed: false }, config: normalizeConfig() });
const mkRoom = (roomCode) => ({ roomCode, gameState: emptyState(), lockReleaseTimer: null, connectedClients: new Map(), joinIdentity: { codesByPlayer: new Map(), playerByCode: new Map(), activeSocketByPlayer: new Map() } });
function getRoom(roomCode) { return rooms.get(String(roomCode || '').trim().toUpperCase()) || null; }
function getOrCreateRoom(roomCode) { const key = String(roomCode || '').trim().toUpperCase(); if (!key) return null; if (!rooms.has(key)) rooms.set(key, mkRoom(key)); return rooms.get(key); }
function activeRoomCode(req) { return String(req.body.roomCode || req.query.room || req.session.activeRoomCode || '').trim().toUpperCase(); }

function generateJoinCode(length = 8) { const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (let i = 0; i < length; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)]; return code; }
function resetJoinIdentity(room, playerNames) { const codesByPlayer = new Map(); const playerByCode = new Map(); playerNames.forEach((name) => { let code = generateJoinCode(); while (playerByCode.has(code)) code = generateJoinCode(); codesByPlayer.set(name, code); playerByCode.set(code, name); }); room.joinIdentity = { codesByPlayer, playerByCode, activeSocketByPlayer: new Map() }; }
function normalizeClientRole(rawRole) { return rawRole === 'host' || rawRole === 'viewer' || rawRole === 'player' ? rawRole : null; }
function computePresenceState(clients) { let hostCount = 0; let viewerCount = 0; let playerCount = 0; const playersConnected = []; clients.forEach((client) => { if (client.role === 'host') hostCount += 1; if (client.role === 'viewer') viewerCount += 1; if (client.role === 'player') { playerCount += 1; if (client.playerName) playersConnected.push(client.playerName); } }); return { totalConnections: clients.size, hostConnections: hostCount, viewerConnections: viewerCount, playerConnections: playerCount, playerNames: [...new Set(playersConnected)], hostConnected: hostCount > 0 }; }
function resolvePlayerJoin({ joinCode, socketId, joinIdentityState }) { const mappedPlayerName = joinIdentityState.playerByCode.get(joinCode); if (!mappedPlayerName) return { rejectedReason: 'invalid-join-code', playerName: null, identityBound: false, existingSocketId: null }; const existingSocketId = joinIdentityState.activeSocketByPlayer.get(mappedPlayerName) || null; return { rejectedReason: null, playerName: mappedPlayerName, identityBound: true, existingSocketId: existingSocketId && existingSocketId !== socketId ? existingSocketId : null }; }

function publicState(room) { const joinCodes = {}; room.joinIdentity.codesByPlayer.forEach((code, playerName) => { joinCodes[playerName] = { code, link: `/join?room=${encodeURIComponent(room.roomCode)}&code=${encodeURIComponent(code)}` }; }); return { roomCode: room.roomCode, phase: room.gameState.phase, round: room.gameState.round, players: room.gameState.players, board: room.gameState.boardData ? getRoundBoard(room.gameState) : null, revealedClue: room.gameState.revealedClue, buzz: room.gameState.buzz, config: room.gameState.config, quickMoneyPrompts: room.gameState.boardData?.quickMoneyPrompts || [], quickMoney: room.gameState.quickMoney, presence: computePresenceState(room.connectedClients), joinCodes }; }
function emitRoomState(room) { io.to(room.roomCode).emit('state:update', publicState(room)); }

function loadGameData(filePath) { const raw = fs.readFileSync(filePath, 'utf-8'); const parsed = JSON.parse(raw); return parsed; }
function resolveDataFileByName(fileName) { if (!fileName) return null; const dataDir = path.join(__dirname, 'data'); const resolvedPath = path.resolve(dataDir, fileName); if (!fs.existsSync(resolvedPath)) throw new Error(`Local data file not found: ${fileName}`); return resolvedPath; }
function initializeBoardState(data) { ['round1', 'round2'].forEach((roundKey) => data[roundKey].categories.forEach((category) => category.clues.forEach((clue) => { clue.used = false; }))); }

function requireHost(req, res, next) { if (!req.session.isHost) return res.redirect('/host/login'); next(); }
function getHostRoom(req, res) { const code = activeRoomCode(req); const room = getRoom(code); if (!room) { sendHostError(res, 400, HOST_ERROR_CODES.invalidRequest, 'Room not found. Start/setup a room first.'); return null; } req.session.activeRoomCode = code; return room; }

app.get('/', (req, res) => res.render('index'));
app.get('/player', (req, res) => res.redirect(`/join${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`));
app.get('/join', (req, res) => res.render('join'));
app.get('/state', (req, res) => { const room = getRoom(req.query.room); return res.json(room ? publicState(room) : { roomCode: String(req.query.room || '').toUpperCase(), phase: 'setup', round: 1, players: [], buzz: null, joinCodes: {} }); });
app.get('/host/login', (req, res) => res.render('login', { error: null }));
app.post('/host/login', (req, res) => { const { password } = req.body; if (password === HOST_PASSWORD) { req.session.isHost = true; return res.redirect('/host'); } return res.status(401).render('login', { error: 'Invalid password.' }); });
app.get('/host', requireHost, (req, res) => { const room = getRoom(activeRoomCode(req)); res.render('host', { state: room ? publicState(room) : null }); });

app.post('/host/setup', requireHost, upload.single('boardFile'), (req, res) => { const uploadedFilePath = req.file ? req.file.path : null; try { const names = String(req.body.playerNames || '').split(',').map((n) => n.trim()).filter(Boolean); if (names.length < 2) throw new Error('Add at least two players.'); const roomCode = String(req.body.roomCode || '').trim().toUpperCase(); if (!roomCode) throw new Error('Room code is required.'); const room = getOrCreateRoom(roomCode); req.session.activeRoomCode = roomCode; const localDataFilePath = resolveDataFileByName((req.body.localDataFile || '').trim()); const filePath = uploadedFilePath || localDataFilePath || path.join(__dirname, 'data', 'sample-game.json'); const boardData = loadGameData(filePath); initializeBoardState(boardData); room.gameState = initializeGame({ playerNames: names, boardData, topFinalists: 2 }); resetJoinIdentity(room, names); io.to(room.roomCode).emit('state:update', publicState(room)); res.redirect('/host'); } catch (error) { sendHostError(res, 400, HOST_ERROR_CODES.invalidGameData, error.message); } finally { if (uploadedFilePath) fs.unlink(uploadedFilePath, () => {}); } });

function hostAction(req, res, handler) { const room = getHostRoom(req, res); if (!room) return; handler(room); emitRoomState(room); res.sendStatus(200); }
app.post('/host/select-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const result = selectClue(room.gameState, Number(req.body.categoryIndex), Number(req.body.clueIndex)); if (result.error) throw new Error(result.error); room.gameState = result.state; }));
app.post('/host/open-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const result = openBuzz(room.gameState); if (result.error) throw new Error(result.error); room.gameState = result.state; }));
app.post('/host/reset-buzz', requireHost, (req, res) => hostAction(req, res, (room) => { const result = resetBuzz(room.gameState); if (result.error) throw new Error(result.error); room.gameState = result.state; }));
app.post('/host/score-clue', requireHost, (req, res) => hostAction(req, res, (room) => { const result = applyScoreAndBuzzRules(room.gameState, req.body.playerResults || {}); if (result.error) throw new Error(result.error); room.gameState = result.state; }));
app.post('/host/config', requireHost, (req, res) => hostAction(req, res, (room) => { room.gameState = updateConfig(room.gameState, req.body || {}); }));

io.on('connection', (socket) => {
  const role = normalizeClientRole(socket.handshake.query?.role);
  const roomCode = String(socket.handshake.query?.roomCode || '').trim().toUpperCase();
  const room = getRoom(roomCode);
  if (!room) return socket.disconnect(true);
  socket.join(roomCode);
  let playerName = null; let identityBound = false; let rejectedReason = null;
  if (role === 'player') {
    const joinCode = String(socket.handshake.query?.joinCode || '').trim().toUpperCase();
    const resolution = resolvePlayerJoin({ joinCode, socketId: socket.id, joinIdentityState: room.joinIdentity });
    rejectedReason = resolution.rejectedReason; playerName = resolution.playerName; identityBound = resolution.identityBound;
    if (!rejectedReason) room.joinIdentity.activeSocketByPlayer.set(playerName, socket.id);
  }
  room.connectedClients.set(socket.id, { role, playerName, identityBound });
  if (rejectedReason) { socket.emit('auth:rejected', { reason: rejectedReason }); socket.disconnect(true); return; }
  emitRoomState(room); socket.emit('state:update', publicState(room));
  socket.on('player:buzz', () => {
    const client = room.connectedClients.get(socket.id);
    if (!client?.playerName || !room.gameState.buzz?.open || room.gameState.buzz?.lockedBy) return;
    const result = lockBuzz(room.gameState, client.playerName, Date.now()); if (result.error) return;
    room.gameState = result.state; io.to(roomCode).emit('buzz:locked', { playerName: client.playerName }); emitRoomState(room);
  });
  socket.on('disconnect', () => {
    const client = room.connectedClients.get(socket.id);
    if (client?.playerName && room.joinIdentity.activeSocketByPlayer.get(client.playerName) === socket.id) room.joinIdentity.activeSocketByPlayer.delete(client.playerName);
    room.connectedClients.delete(socket.id); emitRoomState(room);
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`Mogul Money clone running on http://localhost:${PORT}`));

module.exports = { app, server, io, attemptBuzz: () => {}, computePresenceState, resolvePlayerJoin, __testHooks: { rooms, getOrCreateRoom, publicState } };
