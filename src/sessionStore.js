const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'sessions');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const STATS_PATH = path.join(__dirname, '..', 'data', 'player-stats.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
}

function safeCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function filePathFor(roomCode, archived = false) {
  const file = `${safeCode(roomCode)}.json`;
  return path.join(archived ? ARCHIVE_DIR : DATA_DIR, file);
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function saveSession(roomCode, state) {
  ensureDirs();
  const code = safeCode(roomCode);
  if (!code) throw new Error('Room code is required.');
  const now = new Date().toISOString();
  const payload = {
    roomCode: code,
    updatedAt: now,
    createdAt: state?.createdAt || now,
    archived: false,
    state
  };
  atomicWrite(filePathFor(code), JSON.stringify(payload, null, 2));
  return payload;
}

function loadSession(roomCode) {
  ensureDirs();
  const code = safeCode(roomCode);
  const activePath = filePathFor(code);
  const archivedPath = filePathFor(code, true);
  const target = fs.existsSync(activePath) ? activePath : archivedPath;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, 'utf-8'));
}

function listSessions() {
  ensureDirs();
  const readMeta = (dir, archived) => fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      return {
        roomCode: parsed.roomCode,
        updatedAt: parsed.updatedAt,
        createdAt: parsed.createdAt,
        archived
      };
    });
  return [...readMeta(DATA_DIR, false), ...readMeta(ARCHIVE_DIR, true)]
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function readPlayerStats() {
  ensureDirs();
  if (!fs.existsSync(STATS_PATH)) return {};
  return JSON.parse(fs.readFileSync(STATS_PATH, 'utf-8'));
}

function writePlayerStats(stats) {
  atomicWrite(STATS_PATH, JSON.stringify(stats, null, 2));
}

function normalizedBuzzMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updateAggregatePlayerStatsFromState(state) {
  const players = Array.isArray(state?.players) ? state.players : [];
  if (!players.length) return;
  const topScore = Math.max(...players.map((p) => Number(p?.score || 0)));
  const winners = new Set(players.filter((p) => Number(p?.score || 0) === topScore).map((p) => String(p?.name || '').trim()).filter(Boolean));

  const attempts = Array.isArray(state?.buzz?.attempts) ? state.buzz.attempts : [];
  const fastestByPlayer = new Map();
  attempts.forEach((attempt) => {
    const name = String(attempt?.playerName || '').trim();
    if (!name) return;
    const buzzMs = normalizedBuzzMs(attempt?.buzzMs ?? attempt?.at);
    if (buzzMs == null) return;
    const prev = fastestByPlayer.get(name);
    if (prev == null || buzzMs < prev) fastestByPlayer.set(name, buzzMs);
  });

  const current = readPlayerStats();
  players.forEach((p) => {
    const name = String(p?.name || '').trim();
    if (!name) return;
    const score = Number(p?.score || 0);
    const existing = current[name] || { totalGames: 0, wins: 0, averageScore: 0, fastestBuzz: null, totalScore: 0 };
    const totalGames = Number(existing.totalGames || 0) + 1;
    const totalScore = Number(existing.totalScore || 0) + score;
    const fastestBuzz = fastestByPlayer.has(name)
      ? (existing.fastestBuzz == null ? fastestByPlayer.get(name) : Math.min(Number(existing.fastestBuzz), fastestByPlayer.get(name)))
      : (existing.fastestBuzz == null ? null : Number(existing.fastestBuzz));
    current[name] = {
      totalGames,
      wins: Number(existing.wins || 0) + (winners.has(name) ? 1 : 0),
      averageScore: totalScore / totalGames,
      fastestBuzz,
      totalScore
    };
  });

  writePlayerStats(current);
}

function getLeaderboard(sortBy = 'wins', order = 'desc', offset = 0, limit = 20) {
  const stats = readPlayerStats();
  const entries = Object.entries(stats).map(([name, s]) => ({
    name,
    totalGames: Number(s.totalGames || 0),
    wins: Number(s.wins || 0),
    averageScore: Number(s.averageScore || 0),
    fastestBuzz: s.fastestBuzz == null ? null : Number(s.fastestBuzz)
  }));
  const dir = String(order).toLowerCase() === 'asc' ? 1 : -1;
  entries.sort((a, b) => {
    const av = a[sortBy];
    const bv = b[sortBy];
    if (sortBy === 'fastestBuzz') {
      if (av == null && bv == null) return a.name.localeCompare(b.name);
      if (av == null) return 1;
      if (bv == null) return -1;
    }
    if (av === bv) return a.name.localeCompare(b.name);
    return av > bv ? dir : -dir;
  });
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20));
  return { total: entries.length, entries: entries.slice(safeOffset, safeOffset + safeLimit) };
}

function archiveSession(roomCode) {
  ensureDirs();
  const code = safeCode(roomCode);
  const active = filePathFor(code);
  if (!fs.existsSync(active)) return false;
  const archived = filePathFor(code, true);
  const payload = JSON.parse(fs.readFileSync(active, 'utf-8'));
  payload.archived = true;
  payload.updatedAt = new Date().toISOString();
  updateAggregatePlayerStatsFromState(payload.state || {});
  atomicWrite(archived, JSON.stringify(payload, null, 2));
  fs.unlinkSync(active);
  return true;
}

function getSessionExportJSON(roomCode) { /* unchanged */
  const saved = loadSession(roomCode);
  if (!saved) return null;
  const state = saved.state || {};
  const players = Array.isArray(state.players) ? state.players : [];
  const sortedPlayers = [...players].sort((a, b) => Number(b?.score || 0) - Number(a?.score || 0));
  const topScore = sortedPlayers.length ? Number(sortedPlayers[0]?.score || 0) : null;
  const winners = sortedPlayers.filter((player) => Number(player?.score || 0) === topScore).map((player) => player.name);
  const cluesAsked = [];
  for (const roundKey of ['round1', 'round2']) {
    const categories = state.boardData?.[roundKey]?.categories || [];
    categories.forEach((category, categoryIndex) => {
      (category?.clues || []).forEach((clue, clueIndex) => {
        if (!clue?.used) return;
        cluesAsked.push({ round: roundKey, categoryIndex, clueIndex, category: category?.name || '', value: Number(clue?.value || 0), answer: clue?.answer || '', question: clue?.question || '' });
      });
    });
  }
  return { roomCode: saved.roomCode, createdAt: saved.createdAt, updatedAt: saved.updatedAt, archived: Boolean(saved.archived), phase: state.phase || null, round: Number(state.round || 0), scores: players.map((player) => ({ name: player?.name || '', score: Number(player?.score || 0) })), winners, cluesAsked, quickMoneyAnswers: state.quickMoney?.answers || {}, submittedAnswers: Array.isArray(state.archivedAnswers) ? state.archivedAnswers : [] };
}
function csvEscape(value) { const text = String(value ?? ''); if (!/[",\n]/.test(text)) return text; return `"${text.replace(/"/g, '""')}"`; }
function getSessionExportCSV(roomCode) { const snapshot = getSessionExportJSON(roomCode); if (!snapshot) return null; const rows = []; const push = (row) => rows.push(row.map(csvEscape).join(',')); push(['section', 'roomCode', 'phase', 'round', 'name', 'score', 'winner', 'roundKey', 'category', 'categoryIndex', 'clueIndex', 'value', 'answer', 'question', 'finalist', 'promptIndex', 'points', 'playerName', 'clueKey', 'submittedAt']); (snapshot.scores || []).forEach((entry) => { push(['score', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', entry.name || '', entry.score || 0, snapshot.winners.includes(entry.name) ? 'yes' : 'no', '', '', '', '', '', '', '', '', '', '', '', '', '']); }); (snapshot.cluesAsked || []).forEach((clue) => { push(['clue', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', '', '', '', clue.round || '', clue.category || '', clue.categoryIndex, clue.clueIndex, clue.value || '', clue.answer || '', clue.question || '', '', '', '', '', '', '']); }); Object.entries(snapshot.quickMoneyAnswers || {}).forEach(([finalist, answers]) => { (Array.isArray(answers) ? answers : []).forEach((entry) => { push(['quickMoney', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', '', '', '', '', '', '', '', '', '', '', finalist, Number(entry?.promptIndex || 0), Number(entry?.points || 0), '', '', '']); }); });
  (snapshot.submittedAnswers || []).forEach((entry) => { push(['submittedAnswer', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', '', '', '', '', '', '', '', '', '', '', '', '', '', entry.playerName || '', entry.clueKey || '', Number(entry.submittedAt || 0)]); }); return rows.join('\n'); }

module.exports = { saveSession, loadSession, listSessions, archiveSession, getSessionExportJSON, getSessionExportCSV, getLeaderboard, readPlayerStats };
