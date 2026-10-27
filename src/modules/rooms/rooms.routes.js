import { Router } from 'express';
import { z } from 'zod';
import { authorize } from '../../core/auth.js';
import { validate, idParam } from '../../core/validate.js';
import { ROOM_STATUSES, getBoard, getRoomDetail } from './board.service.js';
import * as mapping from './mapping.service.js';
import * as roomsService from './rooms.service.js';
import { checkAdapterHealth } from '../../jobs/adapterHealth.job.js';
import { db } from '../../config/db.js';
import { notFound } from '../../core/errors.js';
import { can } from '../../core/permissions.js';
import { availabilityHandler } from '../stays/stays.routes.js';

const router = Router();

const listOf = (item) =>
  z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(item));

// Static paths first so they are not taken as a room id.
router.get(
  '/board',
  authorize('board:read'),
  validate({
    query: z.object({
      floor: listOf(z.coerce.number().int()).optional(),
      status: listOf(z.enum(ROOM_STATUSES)).optional(),
      roomType: listOf(z.string().min(1)).optional(),
    }),
  }),
  async (req, res) => {
    res.json({ success: true, data: await getBoard(req.valid.query) });
  },
);

router.get('/mapping', authorize('mapping:manage'), async (req, res) => {
  res.json({ success: true, data: await mapping.getMapping() });
});

const DEVICE_TYPES = ['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other'];

const mappingBody = z.object({
  floors: z.array(z.object({ number: z.number().int().min(-10).max(300), name: z.string().trim().max(80).optional() })).max(500),
  roomTypes: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  adapters: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        vendor: z.string().trim().min(1).max(40),
        isEnabled: z.boolean().optional(),
        config: z.record(z.string(), z.any()).optional(),
      }),
    )
    .max(50)
    .default([]),
  rooms: z
    .array(
      z.object({
        number: z.string().trim().min(1).max(20),
        floor: z.number().int(),
        roomType: z.string().trim().min(1).max(80).optional(),
        isActive: z.boolean().optional(),
        devices: z
          .array(
            z.object({
              adapter: z.string().trim().min(1).max(80),
              externalId: z.string().trim().min(1).max(120),
              type: z.enum(DEVICE_TYPES),
              name: z.string().trim().max(120).optional(),
              // What the guest app may do, e.g. { dimmable: true } or { inputs: ['hdmi1','tv'] }. Omit to keep current.
              capabilities: z.record(z.string(), z.any()).nullable().optional(),
            }),
          )
          .max(100)
          .default([]),
      }),
    )
    .max(5000),
});

router.put('/mapping', authorize('mapping:manage'), validate({ body: mappingBody }), async (req, res) => {
  res.json({ success: true, data: await mapping.putMapping(req.valid.body, { id: req.staff.id, ip: req.ip }) });
});

router.get('/mapping/adapters', authorize('mapping:manage'), async (req, res) => {
  res.json({ success: true, data: await mapping.listAdapters() });
});

router.post('/mapping/adapters/:id/secret', authorize('mapping:manage'), validate({ params: idParam }), async (req, res) => {
  res.json({ success: true, data: await mapping.rotateWebhookSecret(req.valid.params.id, { id: req.staff.id, ip: req.ip }) });
});

router.post('/mapping/adapters/:id/check', authorize('mapping:manage'), validate({ params: idParam }), async (req, res) => {
  const adapter = await db('adapters').where({ id: req.valid.params.id }).first();
  if (!adapter) throw notFound('Adapter');
  await checkAdapterHealth(adapter);
  res.json({ success: true, data: (await mapping.listAdapters()).find((a) => a.id === adapter.id) });
});

const roomBody = z.object({
  number: z.string().trim().min(1).max(20),
  floor: z.coerce.number().int().min(-10).max(300),
  roomType: z.string().trim().min(1).max(80).optional(),
  basePrice: z.coerce.number().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
  imageUrl: z.string().trim().optional(),
  images: z.array(z.string().trim()).optional(),
  devices: z.array(z.object({
  id: z.coerce.number().optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other']),
  externalId: z.string().trim().max(120).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
  isActive: z.boolean().optional(),
})).optional(),
});

const roomUpdateBody = z.object({
  number: z.string().trim().min(1).max(20).optional(),
  floor: z.coerce.number().int().min(-10).max(300).optional(),
  roomType: z.string().trim().min(1).max(80).nullable().optional(),
  basePrice: z.coerce.number().min(0).max(100000).nullable().optional(),
  isActive: z.boolean().optional(),
  dnd: z.boolean().optional(),
  imageUrl: z.string().trim().nullable().optional(),
  images: z.array(z.string().trim()).nullable().optional(),
  devices: z.array(z.object({
  id: z.coerce.number().optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other']),
  externalId: z.string().trim().max(120).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
  isActive: z.boolean().optional(),
})).optional(),
});

router.post(
  '/upload',
  authorize('mapping:manage'),
  validate({
    body: z.object({
      dataUrl: z.string().min(1),
    }),
  }),
  async (req, res) => {
    res.json({
      success: true,
      data: await roomsService.uploadRoomPhoto(req.valid.body.dataUrl, { id: req.staff.id, ip: req.ip }),
    });
  },
);

router.post('/', authorize('mapping:manage'), validate({ body: roomBody }), async (req, res) => {
  res.status(201).json({
    success: true,
    data: await roomsService.createRoom(req.valid.body, { id: req.staff.id, ip: req.ip }),
  });
});

router.patch('/:id', authorize('mapping:manage'), validate({ params: idParam, body: roomUpdateBody }), async (req, res) => {
  res.json({
    success: true,
    data: await roomsService.updateRoom(req.valid.params.id, req.valid.body, { id: req.staff.id, ip: req.ip }),
  });
});

router.delete('/:id', authorize('mapping:manage'), validate({ params: idParam }), async (req, res) => {
  res.json({
    success: true,
    data: await roomsService.deleteRoom(req.valid.params.id, { id: req.staff.id, ip: req.ip }),
  });
});

// Free rooms for a date range (front desk). Registered before "/:id" so it isn't taken as a room id.
router.get('/availability', ...availabilityHandler);

router.get('/:id', authorize('board:read'), validate({ params: idParam }), async (req, res) => {
  const includeContact = can(req.staff.role, 'stays:read');
  res.json({ success: true, data: await getRoomDetail(req.valid.params.id, { includeContact }) });
});


/* ---- Room Hardware Devices Management ----------------------------- */

router.get('/:id/devices', authorize('board:read'), validate({ params: idParam }), async (req, res) => {
  res.json({
    success: true,
    data: await roomsService.getRoomDevicesList(req.valid.params.id),
  });
});

const addDeviceBody = z.object({
  type: z.enum(['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other']),
  name: z.string().trim().min(1).max(120),
  adapterId: z.coerce.number().int().optional(),
  externalId: z.string().trim().max(120).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

router.post('/:id/devices', authorize('mapping:manage'), validate({ params: idParam, body: addDeviceBody }), async (req, res) => {
  res.status(201).json({
    success: true,
    data: await roomsService.addDeviceToRoom(req.valid.params.id, req.valid.body, { id: req.staff.id, ip: req.ip }),
  });
});

const updateDeviceBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.enum(['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other']).optional(),
  isActive: z.boolean().optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
});

router.patch(
  '/:id/devices/:deviceId',
  authorize('mapping:manage'),
  validate({
    params: z.object({ id: z.coerce.number().int(), deviceId: z.coerce.number().int() }),
    body: updateDeviceBody,
  }),
  async (req, res) => {
    res.json({
      success: true,
      data: await roomsService.updateRoomDevice(req.valid.params.id, req.valid.params.deviceId, req.valid.body, { id: req.staff.id, ip: req.ip }),
    });
  }
);

router.delete(
  '/:id/devices/:deviceId',
  authorize('mapping:manage'),
  validate({
    params: z.object({ id: z.coerce.number().int(), deviceId: z.coerce.number().int() }),
  }),
  async (req, res) => {
    res.json({
      success: true,
      data: await roomsService.deleteRoomDevice(req.valid.params.id, req.valid.params.deviceId, { id: req.staff.id, ip: req.ip }),
    });
  }
);

export default router;
