import { z } from 'zod';
import { ROLES } from '../config/permissions.js';
import { pageQuery, boolish } from './common.validator.js';

/** GET /admin/staff */
export const listStaffQuery = z.object({ role: z.enum(ROLES).optional(), active: boolish.optional(), q: z.string().trim().max(100).optional(), ...pageQuery });

/** POST /admin/staff */
export const createStaffBody = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(190),
  role: z.enum(ROLES),
  password: z.string().min(1).max(200),
});

/** PATCH /admin/staff/:id */
export const updateStaffBody = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    email: z.email().max(190).optional(),
    role: z.enum(ROLES).optional(),
    isActive: z.boolean().optional(),
    password: z.string().min(1).max(200).optional(),
    resetOtp: z.literal(true).optional(),
    unlock: z.literal(true).optional(),
  })
  .strict();
