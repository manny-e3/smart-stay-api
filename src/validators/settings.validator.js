import { z } from 'zod';
import { isValidTimeZone } from '../utils/time.js';

/** PUT /admin/settings accepts any subset; the merged result is checked with settingsSchema. */
export const updateSettingsBody = z.record(z.string(), z.any());

/** The full, valid set of hotel settings. */
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
