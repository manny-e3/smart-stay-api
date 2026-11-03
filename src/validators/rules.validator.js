import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { pageQuery, boolish } from './common.validator.js';

/**
 * Rules (Release 2).
 *  schedule: runs at a cron time, e.g. "0 23 * * *" = every day at 23:00 (UTC).
 *  vacancy:  checked every minute; acts on rooms that have been empty longer than the delay.
 *
 * target:     { scope: 'all' } | { scope: 'floors', floors: [1,2] } | { scope: 'rooms', roomIds: [..] } | { scope: 'roomTypes', roomTypes: ['Suite'] }
 * conditions: schedule -> { occupancy: 'any' | 'vacant' | 'occupied' }
 *             vacancy  -> { trigger: 'unsold' | 'no_presence', delayMinutes?: number }  (delay defaults to the eco delay setting)
 * actions:    [{ type: 'set_climate', mode: 'eco'|'cool'|'heat'|'auto'|'off', setpoint?: number },
 *              { type: 'lights', on: boolean }, { type: 'curtains', open: boolean }]
 */

const targetSchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all') }),
  z.object({ scope: z.literal('floors'), floors: z.array(z.number().int()).min(1) }),
  z.object({ scope: z.literal('rooms'), roomIds: z.array(z.number().int().positive()).min(1) }),
  z.object({ scope: z.literal('roomTypes'), roomTypes: z.array(z.string().min(1)).min(1) }),
]);

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_climate'), mode: z.enum(['eco', 'cool', 'heat', 'auto', 'off']), setpoint: z.number().min(10).max(35).optional() }),
  z.object({ type: z.literal('lights'), on: z.boolean() }),
  z.object({ type: z.literal('curtains'), open: z.boolean() }),
]);

/** POST /admin/rules, and the merged result of PATCH /admin/rules/:id */
export const ruleInputSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    type: z.enum(['schedule', 'vacancy']),
    isEnabled: z.boolean().default(true),
    cron: z.string().trim().max(120).optional(),
    target: targetSchema,
    conditions: z
      .object({
        occupancy: z.enum(['any', 'vacant', 'occupied']).optional(),
        trigger: z.enum(['unsold', 'no_presence']).optional(),
        delayMinutes: z.number().int().min(1).max(1440).optional(),
      })
      .default({}),
    actions: z.array(actionSchema).min(1).max(10),
  })
  .superRefine((r, ctx) => {
    if (r.type === 'schedule') {
      if (!r.cron) ctx.addIssue({ code: 'custom', path: ['cron'], message: 'A cron schedule is required for schedule rules' });
      else {
        try {
          CronExpressionParser.parse(r.cron);
        } catch {
          ctx.addIssue({ code: 'custom', path: ['cron'], message: 'Invalid cron expression' });
        }
      }
    }
    if (r.type === 'vacancy' && !r.conditions.trigger) {
      ctx.addIssue({ code: 'custom', path: ['conditions', 'trigger'], message: 'Vacancy rules need a trigger: unsold or no_presence' });
    }
  });

/** GET /admin/rules */
export const listRulesQuery = z.object({ type: z.enum(['schedule', 'vacancy']).optional(), enabled: boolish.optional() });

/** GET /admin/rules/:id/runs */
export const listRunsQuery = z.object(pageQuery);

/** PATCH /admin/rules/:id: any subset of the fields; the merged rule is checked in the service. */
export const updateRuleBody = z
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
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
