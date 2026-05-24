const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const isDevelopment = process.env.NODE_ENV === 'development';
const HOST_PASSWORD = process.env.HOST_PASSWORD || (isDevelopment ? 'mogulhost' : null);

if (!HOST_PASSWORD) {
  throw new Error('HOST_PASSWORD environment variable is required when NODE_ENV is not development.');
}
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1);

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'mogul-money-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true'
    }
  })
);

const emptyState = () => ({
  phase: 'setup',
  round: 1,
  players: [],
  boardData: null,
  revealedClue: null,
  quickMoney: {
    finalists: [],
    currentFinalistIndex: 0,
    promptIndex: 0,
    answers: {},
    timerEndsAt: null,
    active: false,
    completed: false
  }
});

let gameState = emptyState();

function loadGameData(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  validateGameData(parsed);
  return parsed;
}

function validateGameData(data) {
  const mustHave = ['round1', 'round2', 'quickMoneyPrompts'];
  mustHave.forEach((key) => {
    if (!data[key]) throw new Error(`Missing required key: ${key}`);
  });
}

function initializeBoardState(data) {
  ['round1', 'round2'].forEach((roundKey) => {
    data[roundKey].categories.forEach((category) => {
      category.clues.forEach((clue) => {
        clue.used = false;
      });
    });
  });
}

function getRoundBoard(round) {
  return round === 1 ? gameState.boardData.round1 : gameState.boardData.round2;
}

function sortPlayers() {
  gameState.players.sort((a, b) => b.score - a.score);
}

function allCluesUsed(round) {
  const board = getRoundBoard(round);
  return board.categories.every((cat) => cat.clues.every((clue) => clue.used));
}

function publicState() {
  return {
    phase: gameState.phase,
    round: gameState.round,
    players: gameState.players,
    board: gameState.boardData ? getRoundBoard(gameState.round) : null,
    revealedClue: gameState.revealedClue,
    quickMoney: gameState.quickMoney
  };
}


const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function clientAddress(req) {
  return req.ip || req.connection.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const attempts = (loginAttempts.get(key) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
  loginAttempts.set(key, attempts);
  return attempts.length >= MAX_LOGIN_ATTEMPTS;
}

function registerFailedLogin(req) {
  const key = clientAddress(req);
  const attempts = loginAttempts.get(key) || [];
  attempts.push(Date.now());
  loginAttempts.set(key, attempts);
}

function clearLoginAttempts(req) {
  loginAttempts.delete(clientAddress(req));
}

function requireHost(req, res, next) {
  if (!req.session.isHost) return res.redirect('/host/login');
  next();
}

app.get('/', (req, res) => res.render('index'));
app.get('/host/login', (req, res) => res.render('login', { error: null }));

app.post('/host/login', (req, res, next) => {
  if (isRateLimited(req)) {
    return res.status(429).render('login', { error: 'Too many login attempts. Please try again later.' });
  }

  const { password } = req.body;
  if (password === HOST_PASSWORD) {
    clearLoginAttempts(req);
    return req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.isHost = true;
      return res.redirect('/host');
    });
  }

  registerFailedLogin(req);
  return res.status(401).render('login', { error: 'Invalid password.' });
});

app.post('/host/logout', requireHost, (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    return res.redirect('/host/login');
  });
});

app.get('/host', requireHost, (req, res) => {
  res.render('host', { state: publicState() });
});

app.post('/host/setup', requireHost, upload.single('boardFile'), (req, res) => {
  try {
    const names = (req.body.playerNames || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);

    if (names.length < 2) throw new Error('Add at least two players.');

    const filePath = req.file ? req.file.path : path.join(__dirname, 'data', 'sample-game.json');
    const boardData = loadGameData(filePath);
    initializeBoardState(boardData);

    gameState = emptyState();
    gameState.phase = 'round1';
    gameState.round = 1;
    gameState.players = names.map((name) => ({ name, score: 0 }));
    gameState.boardData = boardData;

    io.emit('state:update', publicState());
    res.redirect('/host');
  } catch (error) {
    res.status(400).send(error.message);
  }
});

app.post('/host/select-clue', requireHost, (req, res) => {
  const { categoryIndex, clueIndex } = req.body;
  const clue = getRoundBoard(gameState.round).categories[categoryIndex].clues[clueIndex];
  if (clue.used) return res.status(400).send('Clue already used.');

  clue.used = true;
  gameState.revealedClue = { ...clue, categoryIndex: Number(categoryIndex), clueIndex: Number(clueIndex) };
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/score-clue', requireHost, (req, res) => {
  const { playerResults } = req.body;
  if (!gameState.revealedClue) return res.status(400).send('No active clue.');

  const clueValue = Number(gameState.revealedClue.value);
  Object.entries(playerResults || {}).forEach(([name, result]) => {
    const player = gameState.players.find((p) => p.name === name);
    if (!player || result === 'skip') return;
    if (result === 'correct') player.score += clueValue;
    if (result === 'incorrect') player.score -= clueValue;
  });

  sortPlayers();
  gameState.revealedClue = null;

  if (allCluesUsed(gameState.round)) {
    if (gameState.round === 1) {
      gameState.round = 2;
      gameState.phase = 'round2';
    } else {
      gameState.phase = 'quickMoney';
      gameState.quickMoney.finalists = [...gameState.players].slice(0, 2).map((p) => p.name);
      gameState.quickMoney.active = true;
    }
  }

  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/mogul-multiplier', requireHost, (req, res) => {
  const { playerName, wager, correct } = req.body;
  const player = gameState.players.find((p) => p.name === playerName);
  if (!player) return res.status(404).send('Player not found.');

  const amount = Math.max(0, Number(wager || 0));
  player.score += correct === 'true' ? amount : -amount;
  sortPlayers();
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/quick-money/start-turn', requireHost, (req, res) => {
  const { seconds } = req.body;
  gameState.quickMoney.timerEndsAt = Date.now() + Number(seconds || 20) * 1000;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/quick-money/submit', requireHost, (req, res) => {
  const { playerName, promptIndex, answer, points } = req.body;
  if (!gameState.quickMoney.answers[playerName]) gameState.quickMoney.answers[playerName] = [];
  gameState.quickMoney.answers[playerName].push({ promptIndex: Number(promptIndex), answer, points: Number(points) });

  const player = gameState.players.find((p) => p.name === playerName);
  if (player) player.score += Number(points);
  sortPlayers();

  io.emit('state:update', publicState());
  res.sendStatus(200);
});

io.on('connection', (socket) => {
  socket.emit('state:update', publicState());
  socket.on('disconnect', () => {});
});

server.listen(PORT, () => {
  console.log(`Mogul Money clone running on http://localhost:${PORT}`);
});
