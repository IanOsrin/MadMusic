// Test environment defaults. Keeps modules that read env at import-time happy
// without ever touching real services. Anything sensitive is a placeholder.
process.env.NODE_ENV = process.env.NODE_ENV || 'development'; // relax rate limits in tests
process.env.MASS_NO_LISTEN = 'true'; // tests drive the app via supertest, never .listen()
process.env.PORT = process.env.PORT || '0';
process.env.HOST = process.env.HOST || '127.0.0.1';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-auth-secret';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret';
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_dummy_secret';
process.env.PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || 'pk_test_dummy_public';
process.env.FM_HOST = process.env.FM_HOST || 'https://fm.invalid';
process.env.FM_DB = process.env.FM_DB || 'TestDB';
process.env.FM_USER = process.env.FM_USER || 'test';
process.env.FM_PASS = process.env.FM_PASS || 'test';
process.env.FM_LAYOUT = process.env.FM_LAYOUT || 'API_Album_Songs';
process.env.FM_TOKENS_LAYOUT = process.env.FM_TOKENS_LAYOUT || 'API_Access_Tokens';
process.env.FM_TIMEZONE_OFFSET = process.env.FM_TIMEZONE_OFFSET || '0';
process.env.EMAIL_HOST = process.env.EMAIL_HOST || 'smtp.invalid';
process.env.EMAIL_PORT = process.env.EMAIL_PORT || '587';
process.env.EMAIL_USER = process.env.EMAIL_USER || 'test@test';
process.env.EMAIL_PASS = process.env.EMAIL_PASS || 'test';
process.env.EMAIL_FROM = process.env.EMAIL_FROM || 'test@test';

// Silence noisy boot-time console.log from fm-client connection pool init
const origLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[INIT]')) return;
  origLog.apply(console, args);
};
