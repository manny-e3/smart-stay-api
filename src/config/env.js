import 'dotenv/config';

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const nodeEnv = process.env.NODE_ENV || 'development';
const isTest = nodeEnv === 'test';

export const env = {
  nodeEnv,
  isTest,
  isProd: nodeEnv === 'production',
  port: num(process.env.PORT, 5000),
  corsOrigins: (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY),
  // Interactive API docs at /docs. On by default except in production.
  docsEnabled: bool(process.env.DOCS_ENABLED, nodeEnv !== 'production'),
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: num(process.env.DB_PORT, 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: isTest ? process.env.DB_NAME_TEST || 'smartstay_test' : process.env.DB_NAME || 'smartstay',
  },
  auth: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    // Guest app tokens and stored key credentials use their own secrets.
    // In development they fall back to values derived from the access secret.
    guestSecret: process.env.JWT_GUEST_SECRET || `${process.env.JWT_ACCESS_SECRET || 'dev-access-secret'}:guest`,
    dataEncryptionSecret: process.env.DATA_ENCRYPTION_SECRET || `${process.env.JWT_ACCESS_SECRET || 'dev-access-secret'}:data`,
    guestTokenDays: num(process.env.GUEST_TOKEN_DAYS, 30),
    accessMinutes: num(process.env.ACCESS_TOKEN_MINUTES, 15),
    refreshDays: num(process.env.REFRESH_TOKEN_DAYS, 7),
    maxAttempts: num(process.env.LOGIN_MAX_ATTEMPTS, 5),
    lockMinutes: num(process.env.LOGIN_LOCK_MINUTES, 15),
  },
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@smartstay.local',
    password: process.env.ADMIN_PASSWORD || 'ChangeMe123!',
    name: process.env.ADMIN_NAME || 'System Admin',
  },
  mail: {
    host: process.env.SMTP_HOST || '',
    port: num(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE),
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'SmartStay <no-reply@smartstay.local>',
  },
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@smartstay.local',
  },
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || '',
  jobs: {
    enabled: !isTest && bool(process.env.JOBS_ENABLED, true),
    devicePollSeconds: num(process.env.DEVICE_POLL_SECONDS, 5),
    escalationSeconds: num(process.env.ESCALATION_CHECK_SECONDS, 30),
    adapterHealthSeconds: num(process.env.ADAPTER_HEALTH_SECONDS, 60),
    rulesTickSeconds: num(process.env.RULES_TICK_SECONDS, 60),
    energyImportMinutes: num(process.env.ENERGY_IMPORT_MINUTES, 60),
    pmsReconcileMinutes: num(process.env.PMS_RECONCILE_MINUTES, 10),
    staysHousekeepingMinutes: num(process.env.STAYS_JOB_MINUTES, 15),
  },
};

if (env.isProd) {
  const missing = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_GUEST_SECRET', 'DATA_ENCRYPTION_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`These secrets must be set in production: ${missing.join(', ')}`);
}
