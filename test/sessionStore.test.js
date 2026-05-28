const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { saveSession, loadSession, listSessions, archiveSession, getSessionExportJSON, getSessionExportCSV, getLeaderboard, readPlayerStats } = require('../src/sessionStore');

const dir = path.join(__dirname, '..', 'data', 'sessions');
const statsPath = path.join(__dirname, '..', 'data', 'player-stats.json');

test.beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(statsPath, { force: true });
});

test('save/load round trip preserves quickMoney buzz and config', () => {
  const state = {
    phase: 'quickMoney',
    quickMoney: { finalists: ['A'], currentFinalistIndex: 0, promptIndex: 1, turnActive: true, answers: { A: [{ promptIndex: 0, answer: 'x', points: 50 }] }, timerEndsAt: Date.now(), active: true, completed: false, topFinalists: 2 },
    buzz: { open: true, lockedBy: 'A', attempts: [{ playerName: 'A' }] },
    config: { reopenOnIncorrect: false, maxAttemptsPerClue: 2, buzzTimeoutSeconds: 5, allowRebuzzBySamePlayer: true }
  };
  saveSession('room1', state);
  const loaded = loadSession('room1');
  assert.deepEqual(loaded.state.quickMoney, state.quickMoney);
  assert.deepEqual(loaded.state.buzz, state.buzz);
  assert.deepEqual(loaded.state.config, state.config);
});

test('list and archive sessions', () => {
  saveSession('abc', { phase: 'round1' });
  assert.equal(listSessions().length, 1);
  assert.equal(archiveSession('abc'), true);
  const listed = listSessions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].archived, true);
});

test('archive accumulates player stats and leaderboard sorts stably', () => {
  saveSession('g1', { players: [{ name: 'A', score: 100 }, { name: 'B', score: 50 }], buzz: { attempts: [{ playerName: 'A', buzzMs: 120 }, { playerName: 'B', buzzMs: 200 }] } });
  saveSession('g2', { players: [{ name: 'A', score: 80 }, { name: 'B', score: 140 }], buzz: { attempts: [{ playerName: 'A', buzzMs: 110 }, { playerName: 'B', buzzMs: 180 }] } });
  saveSession('g3', { players: [{ name: 'A', score: 70 }, { name: 'C', score: 150 }], buzz: { attempts: [{ playerName: 'C', buzzMs: 90 }] } });
  archiveSession('g1'); archiveSession('g2'); archiveSession('g3');

  const stats = readPlayerStats();
  assert.equal(stats.A.totalGames, 3);
  assert.equal(stats.A.wins, 1);
  assert.equal(stats.A.averageScore, (100 + 80 + 70) / 3);
  assert.equal(stats.A.fastestBuzz, 110);

  const board = getLeaderboard('wins', 'desc', 0, 10).entries;
  assert.deepEqual(board.map((p) => p.name), ['A', 'B', 'C']);

  const byAvg = getLeaderboard('averageScore', 'desc', 0, 10).entries;
  assert.deepEqual(byAvg.map((p) => p.name), ['C', 'B', 'A']);
});

test('export helpers return normalized JSON and CSV', () => {
  saveSession('expo1', {
    phase: 'round2',
    round: 2,
    players: [{ name: 'A', score: 500 }, { name: 'B', score: 300 }],
    boardData: {
      round1: { categories: [{ name: 'Cat 1', clues: [{ used: true, value: 100, answer: 'Ans', question: 'Q?' }] }] },
      round2: { categories: [] }
    },
    quickMoney: { answers: { A: [{ promptIndex: 0, answer: 'Alpha', points: 10 }] } }
  });

  const json = getSessionExportJSON('expo1');
  assert.equal(json.roomCode, 'EXPO1');
  assert.deepEqual(json.winners, ['A']);
  assert.equal(json.cluesAsked.length, 1);
  assert.ok(Array.isArray(json.scores));

  const csv = getSessionExportCSV('expo1');
  assert.match(csv, /section,roomCode,phase/);
  assert.match(csv, /score,EXPO1/);
  assert.match(csv, /clue,EXPO1/);
  assert.match(csv, /quickMoney,EXPO1/);
});
