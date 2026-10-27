import { Router } from 'express';
import { authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { idParam } from '../validators/common.validator.js';
import * as v from '../validators/stays.validator.js';
import * as stays from '../controllers/stays.controller.js';

/** Mounted at /admin/stays */
const router = Router();

router.get('/', authorize('stays:read'), validate({ query: v.listQuery }), stays.list);
router.post('/', authorize('stays:write'), validate({ body: v.createBody }), stays.create);
router.post('/scan-qr', authorize('stays:read'), validate({ body: v.scanQrBody }), stays.scanQr);

// One stay
router.get('/:id', authorize('stays:read'), validate({ params: idParam }), stays.detail);
router.patch('/:id', authorize('stays:write'), validate({ params: idParam, body: v.updateBody }), stays.update);
router.post('/:id/check-in', authorize('stays:write'), validate({ params: idParam, body: v.checkInBody }), stays.checkIn);
router.post('/:id/check-out', authorize('stays:write'), validate({ params: idParam, body: v.checkOutBody }), stays.checkOut);
router.post('/:id/move', authorize('stays:write'), validate({ params: idParam, body: v.moveBody }), stays.move);
router.post('/:id/extend', authorize('stays:write'), validate({ params: idParam, body: v.extendBody }), stays.extend);
router.post('/:id/cancel', authorize('stays:write'), validate({ params: idParam, body: v.reasonBody }), stays.cancel);
router.post('/:id/no-show', authorize('stays:write'), validate({ params: idParam, body: v.reasonBody }), stays.noShow);

// Guest app access and digital keys
router.post('/:id/access-code', authorize('stays:write'), validate({ params: idParam, body: v.accessCodeBody }), stays.reissueAccessCode);
router.get('/:id/qr', authorize('stays:read'), validate({ params: idParam }), stays.qr);
router.post('/:id/keys', authorize('stays:write'), validate({ params: idParam }), stays.reissueKeys);

export default router;
