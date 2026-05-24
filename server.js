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
const HOST_PASSWORD = process.env.HOST_PASSWORD || 'mogulhost';
const upload = multer({ dest: path.join(__dirname, 'uploads') });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'mogul-money-secret',
    resave: false,
    saveUninitialized: false
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

function requireHost(req, res, next) {
  if (!req.session.isHost) return res.redirect('/host/login');
  next();
}

app.get('/', (req, res) => res.render('index'));
app.get('/host/login', (req, res) => res.render('login', { error: null }));

app.post('/host/login', (req, res) => {
  const { password } = req.body;
  if (password === HOST_PASSWORD) {
    req.session.isHost = true;
    return res.redirect('/host');
  }
  return res.status(401).render('login', { error: 'Invalid password.' });
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

    gameState = emptyState();
    gameState.phase = 'round1';
    gameState.round = 1;
    gameState.players = names.map((name) => ({ name, score: 0 }));
    gameState.boardData = boardData;

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
