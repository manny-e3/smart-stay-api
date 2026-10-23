import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, idParam, pageQuery, csvEnum, boolish } from '../../core/validate.js';
import * as requests from './requests.service.js';

const router = Router();
const actor = (req) => ({ id: req.staff.id, ip: req.ip });

router.get(
  '/',
  authorize('requests:read'),
  validate({
    query: z.object({
      status: csvEnum(requests.REQUEST_STATUSES).optional(),
      category: csvEnum(requests.REQUEST_CATEGORIES).optional(),
      priority: csvEnum(requests.REQUEST_PRIORITIES).optional(),
      roomId: z.coerce.number().int().positive().optional(),
      assignedTo: z.union([z.literal('me'), z.coerce.number().int().positive()]).optional(),
      unassigned: boolish.optional(),
      escalated: boolish.optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    const query = { ...req.valid.query };
    if (query.assignedTo === 'me') query.assignedTo = req.staff.id;
    res.json({ success: true, data: await requests.listRequests(query) });
  },
);

// Staff who can be assigned requests, for the assignee picker. Registered before "/:id".
router.get('/assignees', authorize('requests:write'), async (req, res) => {
  res.json({ success: true, data: await requests.listAssignees() });
});

router.get('/:id', authorize('requests:read'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await requests.getRequest(req.valid.params.id) });
});

router.post(
  '/',
  authorize('requests:write'),
  validate({
    body: z.object({
      roomId: z.number().int().positive(),
      category: z.enum(requests.REQUEST_CATEGORIES),
      description: z.string().trim().max(1000).optional(),
      priority: z.enum(requests.REQUEST_PRIORITIES).optional(),
      preferredAt: z.coerce.date().optional(),
    }),
  }),
  async (req, res) => {
    res.status(201).json({ success: true, data: await requests.createRequestForGuest(req.valid.body, actor(req)) });
  },
);

router.patch(
  '/:id',
  authorize('requests:write'),
  validate({
    params: idParam,
    body: z
      .object({
        status: z.enum(requests.REQUEST_STATUSES).optional(),
        assignedTo: z.number().int().positive().nullable().optional(),
        priority: z.enum(requests.REQUEST_PRIORITIES).optional(),
        note: z.string().trim().min(1).max(1000).optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await requests.updateRequest(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

export default router;
