import { EventEmitter } from 'node:events';

/**
 * In-process domain event bus. Services publish, listeners (sockets, notifications) react.
 * Listener errors are logged and never break the request that published the event.
 */
class Bus extends EventEmitter {
  publish(name, payload) {
    for (const listener of this.listeners(name)) {
      Promise.resolve()
        .then(() => listener(payload))
        .catch((err) => console.error(`[events] listener for ${name} failed:`, err));
    }
  }
}

export const bus = new Bus();
bus.setMaxListeners(50);

export const EVENTS = {
  ROOM_CHANGED: 'room.changed',
  BOARD_CHANGED: 'board.changed',
  STAY_CHANGED: 'stay.changed',
  DEVICE_STATE: 'device.state',
  REQUEST_CREATED: 'request.created',
  REQUEST_UPDATED: 'request.updated',
  REQUEST_ESCALATED: 'request.escalated',
  ALERT_CREATED: 'alert.created',
  ALERT_UPDATED: 'alert.updated',
  FEEDBACK_CREATED: 'feedback.created',
  FEEDBACK_LOW_RATING: 'feedback.low_rating',
  ADAPTER_HEALTH_CHANGED: 'adapter.health_changed',
  RULE_RUN: 'rule.run',
};
