const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSessionConfig, DEFAULT_PROD_COOKIE_MAX_AGE_MS } = require('../src/envConfig');

test('requires SESSION_SECRET when NODE_ENV is not development', () => {
  assert.throws(
    () => buildSessionConfig({ NODE_ENV: 'production', COOKIE_SECURE: 'true' }),
    /SESSION_SECRET environment variable is required/
  );

  assert.throws(
    () => buildSessionConfig({ NODE_ENV: 'test' }),
    /SESSION_SECRET environment variable is required/
  );
});

test('allows development fallback secret and flexible cookie secure setting', () => {
  const config = buildSessionConfig({ NODE_ENV: 'development', COOKIE_SECURE: 'false' });
  assert.equal(config.secret, 'mogul-money-secret');
  assert.equal(config.cookie.secure, false);
  assert.equal(config.cookie.maxAge, undefined);
});

test('forces secure cookies and maxAge in production', () => {
  const config = buildSessionConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: 'prod-secret',
    COOKIE_SECURE: 'true'
  });

  assert.equal(config.secret, 'prod-secret');
  assert.equal(config.cookie.secure, true);
  assert.equal(config.cookie.maxAge, DEFAULT_PROD_COOKIE_MAX_AGE_MS);
});

test('rejects COOKIE_SECURE=false in production', () => {
  assert.throws(
    () => buildSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'prod-secret', COOKIE_SECURE: 'false' }),
    /COOKIE_SECURE=false is not allowed in production/
  );
});

test('warns when COOKIE_SECURE is missing in production and still forces secure', () => {
  const logs = [];
  const logger = { warn: (message) => logs.push(message) };
  const config = buildSessionConfig({ NODE_ENV: 'production', SESSION_SECRET: 'prod-secret' }, logger);

  assert.equal(config.cookie.secure, true);
  assert.equal(config.cookie.maxAge, DEFAULT_PROD_COOKIE_MAX_AGE_MS);
  assert.equal(logs.length, 1);
});
