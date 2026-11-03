import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/rooms.validator.js';
import * as rooms from '../controllers/rooms.controller.js';
import * as mapping from '../controllers/mapping.controller.js';
import { availabilityQuery } from '../validators/stays.validator.js';
import * as stays from '../controllers/stays.controller.js';

/** Mounted at /admin/rooms */
const router = Router();

// Fixed paths come before "/:id" so they aren't read as a room id.
router.get('/board', authorize('board:read'), validate({ query: v.boardQuery }), rooms.board);
router.get('/availability', authorize('stays:read'), validate({ query: availabilityQuery }), stays.availability);
router.post('/upload', authorize('mapping:manage'), validate({ body: v.uploadPhotoBody }), rooms.uploadPhoto);

// Whole-hotel mapping and device vendor connections (admin)
router.get('/mapping', authorize('mapping:manage'), mapping.get);
router.put('/mapping', authorize('mapping:manage'), validate({ body: v.mappingBody }), mapping.replace);
router.get('/mapping/adapters', authorize('mapping:manage'), mapping.listAdapters);
router.post('/mapping/adapters/:id/secret', authorize('mapping:manage'), validate({ params: idParam }), mapping.rotateSecret);
router.post('/mapping/adapters/:id/check', authorize('mapping:manage'), validate({ params: idParam }), mapping.checkAdapter);

// One room
router.post('/', authorize('mapping:manage'), validate({ body: v.createRoomBody }), rooms.create);
router.get('/:id', authorize('board:read'), validate({ params: idParam }), rooms.detail);
router.patch('/:id', authorize('mapping:manage'), validate({ params: idParam, body: v.updateRoomBody }), rooms.update);
router.delete('/:id', authorize('mapping:manage'), validate({ params: idParam }), rooms.remove);

// Devices in one room
router.get('/:id/devices', authorize('board:read'), validate({ params: idParam }), rooms.listDevices);
router.post('/:id/devices', authorize('mapping:manage'), validate({ params: idParam, body: v.addDeviceBody }), rooms.addDevice);
router.patch('/:id/devices/:deviceId', authorize('mapping:manage'), validate({ params: v.roomDeviceParams, body: v.updateDeviceBody }), rooms.updateDevice);
router.delete('/:id/devices/:deviceId', authorize('mapping:manage'), validate({ params: v.roomDeviceParams }), rooms.removeDevice);

export default router;
