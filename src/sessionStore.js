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

module.exports = { saveSession, loadSession, listSessions, archiveSession };
