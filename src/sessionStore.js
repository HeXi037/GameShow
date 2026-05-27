const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'sessions');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
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

function archiveSession(roomCode) {
  ensureDirs();
  const code = safeCode(roomCode);
  const active = filePathFor(code);
  if (!fs.existsSync(active)) return false;
  const archived = filePathFor(code, true);
  const payload = JSON.parse(fs.readFileSync(active, 'utf-8'));
  payload.archived = true;
  payload.updatedAt = new Date().toISOString();
  atomicWrite(archived, JSON.stringify(payload, null, 2));
  fs.unlinkSync(active);
  return true;
}


function getSessionExportJSON(roomCode) {
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
        cluesAsked.push({
          round: roundKey,
          categoryIndex,
          clueIndex,
          category: category?.name || '',
          value: Number(clue?.value || 0),
          answer: clue?.answer || '',
          question: clue?.question || ''
        });
      });
    });
  }
  return {
    roomCode: saved.roomCode,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
    archived: Boolean(saved.archived),
    phase: state.phase || null,
    round: Number(state.round || 0),
    scores: players.map((player) => ({ name: player?.name || '', score: Number(player?.score || 0) })),
    winners,
    cluesAsked,
    quickMoneyAnswers: state.quickMoney?.answers || {}
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function getSessionExportCSV(roomCode) {
  const snapshot = getSessionExportJSON(roomCode);
  if (!snapshot) return null;
  const rows = [];
  const push = (row) => rows.push(row.map(csvEscape).join(','));
  push(['section', 'roomCode', 'phase', 'round', 'name', 'score', 'winner', 'roundKey', 'category', 'categoryIndex', 'clueIndex', 'value', 'answer', 'question', 'finalist', 'promptIndex', 'points']);
  (snapshot.scores || []).forEach((entry) => {
    push(['score', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', entry.name || '', entry.score || 0, snapshot.winners.includes(entry.name) ? 'yes' : 'no', '', '', '', '', '', '', '', '', '', '']);
  });
  (snapshot.cluesAsked || []).forEach((clue) => {
    push(['clue', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', '', '', '', clue.round || '', clue.category || '', clue.categoryIndex, clue.clueIndex, clue.value || '', clue.answer || '', clue.question || '', '', '', '']);
  });
  Object.entries(snapshot.quickMoneyAnswers || {}).forEach(([finalist, answers]) => {
    (Array.isArray(answers) ? answers : []).forEach((entry) => {
      push(['quickMoney', snapshot.roomCode, snapshot.phase || '', snapshot.round || '', '', '', '', '', '', '', '', '', '', '', finalist, Number(entry?.promptIndex || 0), Number(entry?.points || 0)]);
    });
  });
  return rows.join('\n');
}

module.exports = { saveSession, loadSession, listSessions, archiveSession, getSessionExportJSON, getSessionExportCSV };

