import { z } from 'zod';
import { db } from '../../config/db.js';
import { audit } from '../../core/audit.js';
import { badRequest } from '../../core/errors.js';
import { isValidTimeZone } from '../../core/time.js';

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

export const settingsSchema = z
  .object({
    hotel_name: z.string().trim().min(1).max(120),
    ac_min_temp: z.number().min(10).max(35),
    ac_max_temp: z.number().min(10).max(35),
    eco_enabled: z.boolean(),
    eco_delay_minutes: z.number().int().min(1).max(1440),
    eco_setpoint: z.number().min(10).max(35),
    escalation_minutes: z.number().int().min(1).max(1440),
    phones_per_room: z.number().int().min(0).max(10),
    low_rating_threshold: z.number().int().min(1).max(5),
    alert_email_recipients: z.array(z.email()).max(20),
    timezone: z.string().refine(isValidTimeZone, 'Unknown time zone, use a name like Africa/Lagos'),
    booking_mode: z.enum(['manual', 'pms']),
    no_show_after_hours: z.number().int().min(0).max(72),
    checkout_grace_minutes: z.number().int().min(0).max(720),
    close_requests_on_checkout: z.boolean(),
    email_access_code_to_guest: z.boolean(),
    guest_data_retention_days: z.number().int().min(0).max(3650),
    reception_phone: z.string().trim().max(40),
    guest_faqs: z.array(z.object({ question: z.string().trim().min(1).max(200), answer: z.string().trim().min(1).max(2000) }).strict()).max(50),
    privacy_notice: z.string().max(20000),
    guest_quick_links: z
      .array(z.object({ label: z.string().trim().min(1).max(60), url: z.string().trim().min(1).max(500), icon: z.string().trim().max(40).optional() }).strict())
      .max(12),
    guest_app_login_url: z.string().trim().min(1).max(300),
    guest_commands_per_minute: z.number().int().min(5).max(600),
    apply_guest_preferences_on_check_in: z.boolean(),
  })
  .strict()
  .refine((s) => s.ac_min_temp < s.ac_max_temp, { message: 'ac_min_temp must be lower than ac_max_temp', path: ['ac_min_temp'] })
  .refine((s) => s.eco_setpoint >= s.ac_min_temp && s.eco_setpoint <= s.ac_max_temp, {
    message: 'eco_setpoint must be inside the AC range',
    path: ['eco_setpoint'],
  });

// Short cache so hot paths (board, escalation) don't hit the table every time,
// while other API instances still pick up changes within a few seconds.
const CACHE_MS = 10_000;
let cache = null;
let cachedAt = 0;

export async function getSettings() {
  if (cache && Date.now() - cachedAt < CACHE_MS) return cache;
  const rows = await db('settings').select('key', 'value');
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  cache = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_SETTINGS)) };
  cachedAt = Date.now();
  return cache;
}

export const clearSettingsCache = () => {
  cache = null;
};

/** Accepts a full or partial settings object, validates the merged result and saves it. */
export async function updateSettings(input, { staffId, ip } = {}) {
  const current = await getSettings();
  const merged = { ...current, ...input };
  const parsed = settingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw badRequest('Validation failed', parsed.error.issues.map((i) => ({ field: `body.${i.path.join('.')}`, message: i.message })));
  }
  const changed = Object.keys(parsed.data).filter((k) => JSON.stringify(parsed.data[k]) !== JSON.stringify(current[k]));
  if (changed.length) {
    await db.transaction(async (trx) => {
      for (const key of changed) {
        await trx('settings')
          .insert({ key, value: JSON.stringify(parsed.data[key]), updated_by: staffId ?? null })
          .onConflict('key')
          .merge();
      }
      await audit(
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
