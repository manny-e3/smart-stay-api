import { Router } from 'express';
import * as controller from '../controllers/esp32.controller.js';

const router = Router();

// Inbound telemetry pushed by ESP32 hubs
router.post('/telemetry', controller.postTelemetry);

// Instant emergency hazard alerts pushed by ESP32 hubs
router.post('/alert', controller.postAlert);

// Assign an ESP32 hardware device ID to a room
router.post('/rooms/:roomNumber/assign-hub', controller.postAssignHub);

// Status check for a specific room's hardware
router.get('/rooms/:roomNumber/status', controller.getStatus);

export default router;

