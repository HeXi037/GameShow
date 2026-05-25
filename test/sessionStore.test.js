const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { saveSession, loadSession, listSessions, archiveSession } = require('../src/sessionStore');

const dir = path.join(__dirname, '..', 'data', 'sessions');

test.beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
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
