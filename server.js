const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const multer = require('multer');
const session = require('express-session');
const { Server } = require('socket.io');
const { initializeGame, selectClue, scoreClue, applyMultiplier, advanceQuickMoney, initializeQuickMoney } = require('./src/gameState');

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
    turnActive: false,
    answers: {},
    timerEndsAt: null,
    active: false,
    completed: false
  }
});

let gameState = emptyState();
const connectedClients = new Map();

function normalizeClientRole(rawRole) {
  return rawRole === 'host' || rawRole === 'viewer' ? rawRole : null;
}

function presenceState() {
  let hostCount = 0;
  let viewerCount = 0;

  connectedClients.forEach((role) => {
    if (role === 'host') hostCount += 1;
    if (role === 'viewer') viewerCount += 1;
  });

  return {
    totalConnections: connectedClients.size,
    hostConnections: hostCount,
    viewerConnections: viewerCount,
    hostConnected: hostCount > 0
  };
}

function loadGameData(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Malformed JSON in ${path.basename(filePath)}: ${error.message}`);
  }
  validateGameData(parsed);
  return parsed;
}

function resolveDataFileByName(fileName) {
  if (!fileName) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(fileName)) {
    throw new Error('Local data file name contains invalid characters.');
  }

  const dataDir = path.join(__dirname, 'data');
  const resolvedPath = path.resolve(dataDir, fileName);
  if (!resolvedPath.startsWith(path.resolve(dataDir) + path.sep)) {
    throw new Error('Local data file path is invalid.');
  }

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Local data file not found: ${fileName}`);
  }

  return resolvedPath;
}

function validateGameData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Board JSON must be an object.');
  }

  const expectedRoundValues = {
    round1: [100, 200, 300, 400, 500],
    round2: [200, 400, 600, 800, 1000]
  };

  const validateRound = (roundKey) => {
    const round = data[roundKey];
    if (!round || typeof round !== 'object' || Array.isArray(round)) {
      throw new Error(`Missing or invalid ${roundKey}: expected an object.`);
    }

    if (!Array.isArray(round.categories)) {
      throw new Error(`Missing or invalid ${roundKey}.categories: expected an array of 5 categories.`);
    }
    if (round.categories.length !== 5) {
      throw new Error(`Invalid ${roundKey}.categories: expected exactly 5 categories, got ${round.categories.length}.`);
    }

    round.categories.forEach((category, categoryIndex) => {
      const categoryPath = `${roundKey}.categories[${categoryIndex}]`;
      if (!category || typeof category !== 'object' || Array.isArray(category)) {
        throw new Error(`Invalid ${categoryPath}: expected an object.`);
      }

      if (typeof category.name !== 'string' || !category.name.trim()) {
        throw new Error(`Invalid ${categoryPath}.name: expected a non-empty string.`);
      }

      if (!Array.isArray(category.clues)) {
        throw new Error(`Invalid ${categoryPath}.clues: expected an array of 5 clues.`);
      }
      if (category.clues.length !== 5) {
        throw new Error(`Invalid ${categoryPath}.clues: expected exactly 5 clues, got ${category.clues.length}.`);
      }

      category.clues.forEach((clue, clueIndex) => {
        const cluePath = `${categoryPath}.clues[${clueIndex}]`;
        if (!clue || typeof clue !== 'object' || Array.isArray(clue)) {
          throw new Error(`Invalid ${cluePath}: expected an object.`);
        }

        if (typeof clue.value !== 'number' || Number.isNaN(clue.value)) {
          throw new Error(`Invalid ${cluePath}.value: expected a numeric value.`);
        }
        if (typeof clue.answer !== 'string' || !clue.answer.trim()) {
          throw new Error(`Invalid ${cluePath}.answer: expected a non-empty string.`);
        }
        if (typeof clue.question !== 'string' || !clue.question.trim()) {
          throw new Error(`Invalid ${cluePath}.question: expected a non-empty string.`);
        }

        const expectedValue = expectedRoundValues[roundKey][clueIndex];
        if (clue.value !== expectedValue) {
          throw new Error(
            `Invalid ${cluePath}.value: expected ${expectedValue} for clue index ${clueIndex} in ${roundKey}.`
          );
        }
      });
    });
  };

  validateRound('round1');
  validateRound('round2');

  if (!Array.isArray(data.quickMoneyPrompts)) {
    throw new Error('Missing or invalid quickMoneyPrompts: expected an array of 5 strings.');
  }
  if (data.quickMoneyPrompts.length !== 5) {
    throw new Error(
      `Invalid quickMoneyPrompts: expected exactly 5 prompts, got ${data.quickMoneyPrompts.length}.`
    );
  }
  data.quickMoneyPrompts.forEach((prompt, promptIndex) => {
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error(`Invalid quickMoneyPrompts[${promptIndex}]: expected a non-empty string.`);
    }
  });

  const multiplier = data.round2.mogulMultiplier;
  if (!multiplier || typeof multiplier !== 'object' || Array.isArray(multiplier)) {
    throw new Error('Missing or invalid round2.mogulMultiplier: expected an object.');
  }

  if (!Number.isInteger(multiplier.categoryIndex) || multiplier.categoryIndex < 0 || multiplier.categoryIndex > 4) {
    throw new Error('Invalid round2.mogulMultiplier.categoryIndex: expected an integer from 0 to 4.');
  }
  if (!Number.isInteger(multiplier.clueIndex) || multiplier.clueIndex < 0 || multiplier.clueIndex > 4) {
    throw new Error('Invalid round2.mogulMultiplier.clueIndex: expected an integer from 0 to 4.');
  }

  const multiplierCategory = data.round2.categories[multiplier.categoryIndex];
  if (!multiplierCategory || !multiplierCategory.clues[multiplier.clueIndex]) {
    throw new Error(
      `Invalid round2.mogulMultiplier reference: no clue at categoryIndex ${multiplier.categoryIndex}, clueIndex ${multiplier.clueIndex}.`
    );
  }
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

function initializeQuickMoney(topN = 2) {
  const finalists = [...gameState.players].slice(0, Number(topN) || 2).map((p) => p.name);
  gameState.quickMoney.finalists = finalists;
  gameState.quickMoney.currentFinalistIndex = 0;
  gameState.quickMoney.promptIndex = 0;
  gameState.quickMoney.turnActive = false;
  gameState.quickMoney.answers = {};
  gameState.quickMoney.timerEndsAt = null;
  gameState.quickMoney.active = finalists.length > 0;
  gameState.quickMoney.completed = finalists.length === 0;
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
    quickMoneyPrompts: gameState.boardData?.quickMoneyPrompts || [],
    quickMoney: gameState.quickMoney,
    presence: presenceState()
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
  const uploadedFilePath = req.file ? req.file.path : null;
  try {
    const names = (req.body.playerNames || '')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);

    if (names.length < 2) throw new Error('Add at least two players.');

    const localDataFileName = (req.body.localDataFile || '').trim();
    const localDataFilePath = resolveDataFileByName(localDataFileName);

    const filePath = uploadedFilePath || localDataFilePath || path.join(__dirname, 'data', 'sample-game.json');

    let boardData;
    try {
      boardData = loadGameData(filePath);
    } catch (error) {
      throw new Error(`Unable to load game data: ${error.message}`);
    }

    initializeBoardState(boardData);

    gameState = initializeGame({ playerNames: names, boardData, topFinalists: 2 });

    io.emit('state:update', publicState());
    res.redirect('/host');
  } catch (error) {
    res.status(400).send(error.message);
  } finally {
    if (uploadedFilePath) {
      fs.unlink(uploadedFilePath, (unlinkErr) => {
        if (unlinkErr) {
          console.error(`Failed to remove upload temp file ${uploadedFilePath}:`, unlinkErr.message);
        }
      });
    }
  }
});

app.post('/host/select-clue', requireHost, (req, res) => {
  const { categoryIndex, clueIndex } = req.body;
  const parsedCategoryIndex = Number(categoryIndex);
  const parsedClueIndex = Number(clueIndex);
  const result = selectClue(gameState, parsedCategoryIndex, parsedClueIndex);
  if (result.error === 'Clue not found.') return res.status(404).send(result.error);
  if (result.error) return res.status(400).send(result.error);
  gameState = result.state;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/score-clue', requireHost, (req, res) => {
  const { playerResults } = req.body;
  const result = scoreClue(gameState, playerResults || {});
  if (result.error) return res.status(400).send(result.error);
  gameState = result.state;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/mogul-multiplier', requireHost, (req, res) => {
  const { playerName, wager, correct } = req.body;

  if (!gameState.revealedClue || !gameState.revealedClue.isMogulMultiplier) {
    return res.status(400).send('Mogul Multiplier is not active.');
  }

  const result = applyMultiplier(gameState, { playerName, wager, correct });
  if (result.error) return res.status(400).send(result.error);
  gameState = result.state;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/quick-money/start-turn', requireHost, (req, res) => {
  if (gameState.phase !== 'quickMoney') return res.status(400).send('Quick Money is not active.');
  if (gameState.quickMoney.completed) return res.status(400).send('Quick Money is already complete.');
  const { seconds } = req.body;
  gameState.quickMoney.turnActive = true;
  gameState.quickMoney.timerEndsAt = Date.now() + Number(seconds || 20) * 1000;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

app.post('/host/quick-money/submit', requireHost, (req, res) => {
  if (gameState.phase !== 'quickMoney') return res.status(400).send('Quick Money is not active.');
  if (gameState.quickMoney.completed) return res.status(400).send('Quick Money is already complete.');

  const result = advanceQuickMoney(gameState, req.body);
  if (result.error) return res.status(400).send(result.error);
  gameState = result.state;
  io.emit('state:update', publicState());
  res.sendStatus(200);
});

io.on('connection', (socket) => {
  const role = normalizeClientRole(socket.handshake.query?.role);
  connectedClients.set(socket.id, role);

  io.emit('state:update', publicState());
  socket.emit('state:update', publicState());
  socket.on('disconnect', () => {
    connectedClients.delete(socket.id);
    io.emit('state:update', publicState());
  });
});

server.listen(PORT, () => {
  console.log(`Mogul Money clone running on http://localhost:${PORT}`);
});
