import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { ROLES } from '../../core/permissions.js';
import { validate, idParam, pageQuery, boolish } from '../../core/validate.js';
import * as staff from './staff.service.js';

const router = Router();
router.use(authorize('staff:manage'));

const actor = (req) => ({ id: req.staff.id, ip: req.ip });

router.get(
  '/',
  validate({
    query: z.object({ role: z.enum(ROLES).optional(), active: boolish.optional(), q: z.string().trim().max(100).optional(), ...pageQuery }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await staff.listStaff(req.valid.query) });
  },
);

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await staff.getStaff(req.valid.params.id) });
});

router.post(
  '/',
  validate({
    body: z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().max(190),
      role: z.enum(ROLES),
      password: z.string().min(1).max(200),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await staff.createStaff(req.valid.body, actor(req)) });
  },
);

router.patch(
  '/:id',
  validate({
    params: idParam,
    body: z
      .object({
        name: z.string().trim().min(2).max(120).optional(),
        email: z.email().max(190).optional(),
        role: z.enum(ROLES).optional(),
        isActive: z.boolean().optional(),
        password: z.string().min(1).max(200).optional(),
        resetOtp: z.literal(true).optional(),
        unlock: z.literal(true).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    res.json({ success: true, data: await staff.updateStaff(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

export default router;
