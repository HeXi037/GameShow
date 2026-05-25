const DEFAULT_PROD_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 8;

function parseBooleanEnv(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return null;
}

function buildSessionConfig(env, logger = console) {
  const nodeEnv = env.NODE_ENV;
  const isDevelopment = nodeEnv === 'development';
  const isProduction = nodeEnv === 'production';

  const sessionSecret = env.SESSION_SECRET;
  if (!isDevelopment && !sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required when NODE_ENV is not development.');
  }

  const cookieSecureEnv = parseBooleanEnv(env.COOKIE_SECURE);
  if (isProduction && cookieSecureEnv === false) {
    throw new Error('COOKIE_SECURE=false is not allowed in production. Remove it or set COOKIE_SECURE=true.');
  }

  if (isProduction && cookieSecureEnv == null && logger && typeof logger.warn === 'function') {
    logger.warn('COOKIE_SECURE is not explicitly set; production cookies will still be forced secure.');
  }

  const cookie = {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction ? true : cookieSecureEnv === true,
    ...(isProduction ? { maxAge: DEFAULT_PROD_COOKIE_MAX_AGE_MS } : {})
  };

  return {
    secret: sessionSecret || 'mogul-money-secret',
    resave: false,
    saveUninitialized: false,
    cookie
  };
}

module.exports = {
  DEFAULT_PROD_COOKIE_MAX_AGE_MS,
  parseBooleanEnv,
  buildSessionConfig
};
