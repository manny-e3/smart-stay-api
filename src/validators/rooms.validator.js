import { z } from 'zod';
import { listOf, DEVICE_TYPES } from './common.validator.js';
import { ROOM_STATUSES } from '../services/board.service.js';

/** GET /admin/rooms/board?floor=1,2&status=alert,request&roomType=Suite */
export const boardQuery = z.object({
  floor: listOf(z.coerce.number().int()).optional(),
  status: listOf(z.enum(ROOM_STATUSES)).optional(),
  roomType: listOf(z.string().min(1)).optional(),
});

/** PUT /admin/rooms/mapping: the whole hotel mapping */
export const mappingBody = z.object({
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

/** A device inside a room create/edit body. With an id it edits that device; without, it adds one. */
const roomDevice = z.object({
  id: z.coerce.number().optional(),
  name: z.string().trim().min(1).max(120),
  type: z.enum(DEVICE_TYPES),
  externalId: z.string().trim().max(120).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
  isActive: z.boolean().optional(),
});

/** POST /admin/rooms */
export const createRoomBody = z.object({
  number: z.string().trim().min(1).max(20),
  floor: z.coerce.number().int().min(-10).max(300),
  roomType: z.string().trim().min(1).max(80).optional(),
  basePrice: z.coerce.number().min(0).max(100000).optional(),
  isActive: z.boolean().optional(),
  imageUrl: z.string().trim().optional(),
  images: z.array(z.string().trim()).optional(),
  devices: z.array(roomDevice).optional(),
});

/** PATCH /admin/rooms/:id */
export const updateRoomBody = z.object({
  number: z.string().trim().min(1).max(20).optional(),
  floor: z.coerce.number().int().min(-10).max(300).optional(),
  roomType: z.string().trim().min(1).max(80).nullable().optional(),
  basePrice: z.coerce.number().min(0).max(100000).nullable().optional(),
  isActive: z.boolean().optional(),
  dnd: z.boolean().optional(),
  imageUrl: z.string().trim().nullable().optional(),
  images: z.array(z.string().trim()).nullable().optional(),
  devices: z.array(roomDevice).optional(),
});

/** POST /admin/rooms/upload */
export const uploadPhotoBody = z.object({ dataUrl: z.string().min(1) });

/** POST /admin/rooms/:id/devices */
export const addDeviceBody = z.object({
  type: z.enum(DEVICE_TYPES),
  name: z.string().trim().min(1).max(120),
  adapterId: z.coerce.number().int().optional(),
  externalId: z.string().trim().max(120).optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

/** PATCH /admin/rooms/:id/devices/:deviceId */
export const updateDeviceBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.enum(DEVICE_TYPES).optional(),
  isActive: z.boolean().optional(),
  capabilities: z.record(z.string(), z.any()).nullable().optional(),
});

/** /admin/rooms/:id/devices/:deviceId */
export const roomDeviceParams = z.object({ id: z.coerce.number().int(), deviceId: z.coerce.number().int() });
