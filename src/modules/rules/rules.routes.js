import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, idParam, pageQuery, boolish } from '../../core/validate.js';
import * as rules from './rules.service.js';

const router = Router();
router.use(authorize('rules:manage'));
const actor = (req) => ({ id: req.staff.id, ip: req.ip });

router.get(
  '/',
  validate({ query: z.object({ type: z.enum(['schedule', 'vacancy']).optional(), enabled: boolish.optional() }) }),
  async (req, res) => {
    res.json({ success: true, data: await rules.listRules(req.valid.query) });
  },
);

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await rules.getRule(req.valid.params.id) });
});

router.get('/:id/runs', validate({ params: idParam, query: z.object(pageQuery) }), async (req, res) => {
  await rules.getRule(req.valid.params.id);
  res.json({ success: true, data: await rules.listRuns(req.valid.params.id, req.valid.query) });
});

router.post('/', validate({ body: rules.ruleInputSchema }), async (req, res) => {
  res.status(201).json({ success: true, data: await rules.createRule(req.valid.body, actor(req)) });
});

router.patch(
  '/:id',
  validate({
    params: idParam,
    body: z
      .object({
        name: z.any().optional(),
        type: z.any().optional(),
        isEnabled: z.boolean().optional(),
        cron: z.any().optional(),
        target: z.any().optional(),
        conditions: z.any().optional(),
        actions: z.any().optional(),
      })
      .strict()
      .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await rules.updateRule(req.valid.params.id, req.valid.body, actor(req)) });
  },
);

router.post('/:id/run', validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await rules.runRuleNow(req.valid.params.id, actor(req)) });
});

export default router;
