import { transaction } from '../config/db.js';
import * as Setting from '../models/setting.model.js';
import { recordAudit } from './audit.service.js';
import { badRequest } from '../utils/errors.js';
import { settingsSchema } from '../validators/settings.validator.js';

/** Hotel settings, with the value used when a setting has never been saved. */
export const DEFAULT_SETTINGS = {
  hotel_name: 'SmartStay Hotel',
  ac_min_temp: 18,
  ac_max_temp: 28,
  eco_enabled: true,
  eco_delay_minutes: 30,
  eco_setpoint: 26,
  escalation_minutes: 15,
  phones_per_room: 2,
  low_rating_threshold: 2,
  alert_email_recipients: [],
  // Guests and bookings
  timezone: 'Africa/Lagos',
  booking_mode: 'manual',
  no_show_after_hours: 6,
  checkout_grace_minutes: 60,
  close_requests_on_checkout: true,
  email_access_code_to_guest: true,
  guest_data_retention_days: 365,
  // Guest app
  reception_phone: '',
  guest_faqs: [],
  privacy_notice: '',
  guest_quick_links: [],
  guest_app_login_url: 'smartstay://login',
  guest_commands_per_minute: 30,
  apply_guest_preferences_on_check_in: true,
};

// Short cache so busy code (board, escalation) doesn't read the table every time,
// while other API servers still pick up changes within a few seconds.
const CACHE_MS = 10_000;
let cache = null;
let cachedAt = 0;

export async function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await Setting.findAll();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_SETTINGS)) };
  cachedAt = Date.now();
  return cache;
}

export const clearSettingsCache = () => {
  cache = null;
};

/** Accepts a full or partial settings object, checks the merged result and saves what changed. */
export async function updateSettings(input, { staffId, ip } = {}) {
  const current = await getSettings();
  const parsed = settingsSchema.safeParse({ ...current, ...input });
  if (!parsed.success) {
    throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: `body.${i.path.join('.')}`, message: i.message })));
  }
  const changed = Object.keys(parsed.data).filter((k) => JSON.stringify(parsed.data[k]) !== JSON.stringify(current[k]));
  if (changed.length) {
    await transaction(async (trx) => {
      for (const key of changed) await Setting.upsert(key, parsed.data[key], staffId, trx);
      await recordAudit(
        {
          actor: staffId ? { type: 'staff', id: staffId } : { type: 'system' },
          action: 'settings.update',
          entityType: 'settings',
          details: Object.fromEntries(changed.map((k) => [k, { from: current[k], to: parsed.data[k] }])),
          ip,
        },
        trx,
      );
    });
  }
  clearSettingsCache();
  return getSettings();
}
