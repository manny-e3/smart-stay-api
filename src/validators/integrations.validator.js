import { z } from 'zod';
import { DEVICE_EVENT_TYPES } from '../services/devices.service.js';

/** POST /integrations/adapters/:id/events */
export const deviceEventsBody = z.object({
  events: z
    .array(
      z.object({
        externalId: z.string().min(1).max(120),
        type: z.enum(DEVICE_EVENT_TYPES),
        payload: z.record(z.string(), z.any()).optional(),
        occurredAt: z.coerce.date().optional(),
      }),
    )
    .min(1)
    .max(500),
});
