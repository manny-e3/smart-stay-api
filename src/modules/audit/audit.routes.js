import { Router } from 'express';
import { z } from 'zod';
import { db, paginate } from '../../config/db.js';
import { authorize } from '../../core/auth.js';
import { validate, pageQuery } from '../../core/validate.js';

const router = Router();

/**
 * Audit log search. `action` matches exactly ("room.unlock") or by prefix when it ends
 * with a dot ("request." finds every request action).
 */
router.get(
  '/',
  authorize('audit:read'),
  validate({
    query: z.object({
      staffId: z.coerce.number().int().positive().optional(),
      actorType: z.enum(['staff', 'guest', 'system']).optional(),
      action: z.string().trim().max(60).optional(),
      entityType: z.string().trim().max(40).optional(),
      entityId: z.string().trim().max(40).optional(),
      roomId: z.coerce.number().int().positive().optional(),
      roomNumber: z.string().trim().max(20).optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
      q: z.string().trim().max(100).optional(),
      ...pageQuery,
    }),
  }),
  async (req, res) => {
    const f = req.valid.query;
    const q = db('audit_log as a')
      .leftJoin('staff as s', 's.id', 'a.staff_id')
      .leftJoin('rooms as r', 'r.id', 'a.room_id')
      .leftJoin('guests as g', 'g.id', 'a.guest_id')
      .select('a.*', 's.name as staff_name', 's.email as staff_email', 'r.number as room_number', 'g.first_name as guest_first_name', 'g.last_name as guest_last_name')
      .orderBy('a.created_at', 'desc')
      .orderBy('a.id', 'desc');
    if (f.staffId) q.where('a.staff_id', f.staffId);
    if (f.actorType) q.where('a.actor_type', f.actorType);
    if (f.action) f.action.endsWith('.') ? q.where('a.action', 'like', `${f.action}%`) : q.where('a.action', f.action);
    if (f.entityType) q.where('a.entity_type', f.entityType);
    if (f.entityId) q.where('a.entity_id', f.entityId);
    if (f.roomId) q.where('a.room_id', f.roomId);
    if (f.roomNumber) q.where('r.number', f.roomNumber);
    if (f.from) q.where('a.created_at', '>=', f.from);
    if (f.to) q.where('a.created_at', '<=', f.to);
    if (f.q) {
      q.where((w) =>
        w
          .whereILike('a.action', `%${f.q}%`)
          .orWhereILike('s.name', `%${f.q}%`)
          .orWhereILike('s.email', `%${f.q}%`)
          .orWhereRaw('CAST(a.details AS CHAR) LIKE ?', [`%${f.q}%`]),
      );
    }
    const result = await paginate(q, f);
    res.json({
      success: true,
      data: {
        ...result,
        items: result.items.map((a) => ({
          id: a.id,
          action: a.action,
          actor:
            a.actor_type === 'staff'
              ? { type: 'staff', id: a.staff_id, name: a.staff_name, email: a.staff_email }
              : a.actor_type === 'guest'
                ? { type: 'guest', id: a.guest_id, name: [a.guest_first_name, a.guest_last_name].filter(Boolean).join(' ') }
                : { type: 'system' },
          entityType: a.entity_type,
          entityId: a.entity_id,
          room: a.room_id ? { id: a.room_id, number: a.room_number } : null,
          details: a.details,
          ip: a.ip,
          at: a.created_at,
        })),
      },
    });
  },
);

export default router;
