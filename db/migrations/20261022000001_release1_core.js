/**
 * Release 1 schema: staff and sessions, rooms and devices, stays, requests,
 * alerts, feedback, settings, notifications and the audit log.
 */

const ts = (knex, t, name, { nullable = false, defaultNow = true } = {}) => {
  const col = t.datetime(name, { precision: 3 });
  if (nullable) col.nullable();
  else col.notNullable();
  if (defaultNow) col.defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
  return col;
};

const timestamps = (knex, t) => {
  ts(knex, t, 'created_at');
  ts(knex, t, 'updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
};

export async function up(knex) {
  await knex.schema.createTable('staff', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('email', 190).notNullable().unique();
    t.string('password_hash', 100).notNullable();
    t.enu('role', ['service', 'maintenance', 'front_desk', 'manager', 'admin']).notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('otp_secret', 64).nullable();
    t.boolean('otp_enabled').notNullable().defaultTo(false);
    t.integer('failed_attempts').notNullable().defaultTo(0);
    ts(knex, t, 'locked_until', { nullable: true, defaultNow: false });
    ts(knex, t, 'last_login_at', { nullable: true, defaultNow: false });
    timestamps(knex, t);
    t.index(['role', 'is_active']);
  });

  await knex.schema.createTable('sessions', (t) => {
    t.increments('id');
    t.integer('staff_id').unsigned().notNullable().references('staff.id').onDelete('CASCADE');
    t.string('refresh_token_hash', 64).notNullable().unique();
    t.string('user_agent', 255).nullable();
    t.string('ip', 64).nullable();
    ts(knex, t, 'expires_at', { defaultNow: false });
    ts(knex, t, 'revoked_at', { nullable: true, defaultNow: false });
    ts(knex, t, 'created_at');
    ts(knex, t, 'last_used_at');
    t.index(['staff_id', 'revoked_at']);
  });

  await knex.schema.createTable('floors', (t) => {
    t.increments('id');
    t.integer('number').notNullable().unique();
    t.string('name', 80).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('room_types', (t) => {
    t.increments('id');
    t.string('name', 80).notNullable().unique();
    timestamps(knex, t);
  });

  await knex.schema.createTable('rooms', (t) => {
    t.increments('id');
    t.string('number', 20).notNullable().unique();
    t.integer('floor_id').unsigned().notNullable().references('floors.id');
    t.integer('room_type_id').unsigned().nullable().references('room_types.id');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.boolean('dnd').notNullable().defaultTo(false);
    ts(knex, t, 'dnd_updated_at', { nullable: true, defaultNow: false });
    timestamps(knex, t);
    t.index(['floor_id']);
  });

  await knex.schema.createTable('adapters', (t) => {
    t.increments('id');
    t.string('name', 80).notNullable().unique();
    t.string('vendor', 40).notNullable().defaultTo('mock');
    t.json('config').nullable();
    t.string('webhook_secret_hash', 64).nullable();
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.enu('status', ['unknown', 'healthy', 'degraded', 'down']).notNullable().defaultTo('unknown');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    ts(knex, t, 'last_success_at', { nullable: true, defaultNow: false });
    ts(knex, t, 'last_error_at', { nullable: true, defaultNow: false });
    t.string('last_error', 500).nullable();
    t.integer('latency_ms').nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('devices', (t) => {
    t.increments('id');
    t.integer('adapter_id').unsigned().notNullable().references('adapters.id');
    t.string('external_id', 120).notNullable();
    t.integer('room_id').unsigned().nullable().references('rooms.id').onDelete('SET NULL');
    t.enu('type', ['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'other']).notNullable();
    t.string('name', 120).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
    t.unique(['adapter_id', 'external_id']);
    t.index(['room_id']);
  });

  await knex.schema.createTable('device_states', (t) => {
    t.integer('device_id').unsigned().primary().references('devices.id').onDelete('CASCADE');
    t.boolean('online').notNullable().defaultTo(true);
    t.json('state').nullable();
    ts(knex, t, 'last_seen_at', { nullable: true, defaultNow: false });
    ts(knex, t, 'updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });

  await knex.schema.createTable('device_events', (t) => {
    t.bigIncrements('id');
    t.integer('device_id').unsigned().notNullable().references('devices.id').onDelete('CASCADE');
    t.string('event_type', 40).notNullable();
    t.json('payload').nullable();
    ts(knex, t, 'occurred_at');
    ts(knex, t, 'received_at');
    t.index(['device_id', 'occurred_at']);
  });

  await knex.schema.createTable('guests', (t) => {
    t.increments('id');
    t.string('first_name', 80).notNullable();
    t.string('last_name', 80).nullable();
    t.string('email', 190).nullable();
    t.string('phone', 40).nullable();
    t.string('language', 10).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('stays', (t) => {
    t.increments('id');
    t.integer('room_id').unsigned().notNullable().references('rooms.id');
    t.integer('guest_id').unsigned().notNullable().references('guests.id');
    t.enu('status', ['reserved', 'checked_in', 'checked_out']).notNullable().defaultTo('reserved');
    ts(knex, t, 'check_in_at', { defaultNow: false });
    ts(knex, t, 'check_out_at', { defaultNow: false });
    t.integer('guest_count').notNullable().defaultTo(1);
    timestamps(knex, t);
    t.index(['room_id', 'status']);
  });

  await knex.schema.createTable('guest_devices', (t) => {
    t.increments('id');
    t.integer('guest_id').unsigned().notNullable().references('guests.id').onDelete('CASCADE');
    t.integer('stay_id').unsigned().nullable().references('stays.id').onDelete('CASCADE');
    t.string('push_token', 255).notNullable().unique();
    t.enu('platform', ['ios', 'android', 'web']).notNullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('requests', (t) => {
    t.increments('id');
    t.integer('room_id').unsigned().notNullable().references('rooms.id');
    t.integer('stay_id').unsigned().nullable().references('stays.id');
    t.integer('guest_id').unsigned().nullable().references('guests.id');
    t.enu('category', ['housekeeping', 'amenities', 'maintenance', 'food', 'laundry', 'other']).notNullable();
    t.string('description', 1000).nullable();
    t.enu('priority', ['normal', 'high', 'urgent']).notNullable().defaultTo('normal');
    t.enu('status', ['new', 'assigned', 'in_progress', 'done', 'cancelled']).notNullable().defaultTo('new');
    t.enu('source', ['guest', 'staff']).notNullable();
    t.integer('assigned_to').unsigned().nullable().references('staff.id');
    t.integer('created_by_staff_id').unsigned().nullable().references('staff.id');
    ts(knex, t, 'escalated_at', { nullable: true, defaultNow: false });
    ts(knex, t, 'completed_at', { nullable: true, defaultNow: false });
    timestamps(knex, t);
    t.index(['status', 'created_at']);
    t.index(['room_id', 'status']);
    t.index(['assigned_to', 'status']);
  });

  await knex.schema.createTable('request_events', (t) => {
    t.increments('id');
    t.integer('request_id').unsigned().notNullable().references('requests.id').onDelete('CASCADE');
    t.integer('staff_id').unsigned().nullable().references('staff.id');
    t.enu('actor_type', ['staff', 'guest', 'system']).notNullable();
    t.string('action', 40).notNullable();
    t.string('from_status', 20).nullable();
    t.string('to_status', 20).nullable();
    t.string('note', 1000).nullable();
    t.json('data').nullable();
    ts(knex, t, 'created_at');
    t.index(['request_id', 'created_at']);
  });

  await knex.schema.createTable('feedback', (t) => {
    t.increments('id');
    t.integer('room_id').unsigned().notNullable().references('rooms.id');
    t.integer('stay_id').unsigned().nullable().references('stays.id');
    t.integer('guest_id').unsigned().nullable().references('guests.id');
    t.tinyint('rating').unsigned().notNullable();
    t.string('category', 40).nullable();
    t.text('comment').nullable();
    ts(knex, t, 'created_at');
    t.index(['created_at']);
    t.index(['room_id']);
  });

  await knex.schema.createTable('feedback_photos', (t) => {
    t.increments('id');
    t.integer('feedback_id').unsigned().notNullable().references('feedback.id').onDelete('CASCADE');
    t.string('url', 500).notNullable();
    ts(knex, t, 'created_at');
  });

  await knex.schema.createTable('alerts', (t) => {
    t.increments('id');
    t.integer('room_id').unsigned().nullable().references('rooms.id');
    t.integer('device_id').unsigned().nullable().references('devices.id').onDelete('SET NULL');
    t.integer('adapter_id').unsigned().nullable().references('adapters.id').onDelete('SET NULL');
    t.integer('feedback_id').unsigned().nullable().references('feedback.id').onDelete('SET NULL');
    t.string('type', 40).notNullable();
    t.enu('severity', ['info', 'warning', 'critical']).notNullable().defaultTo('warning');
    t.enu('source', ['device', 'guest', 'system']).notNullable();
    t.string('title', 200).notNullable();
    t.string('message', 1000).nullable();
    t.string('dedupe_key', 190).notNullable();
    t.enu('status', ['open', 'resolved']).notNullable().defaultTo('open');
    t.integer('occurrence_count').notNullable().defaultTo(1);
    ts(knex, t, 'first_seen_at');
    ts(knex, t, 'last_seen_at');
    ts(knex, t, 'resolved_at', { nullable: true, defaultNow: false });
    t.integer('resolved_by').unsigned().nullable().references('staff.id');
    t.string('resolution_note', 1000).nullable();
    timestamps(knex, t);
    t.index(['dedupe_key', 'status']);
    t.index(['status', 'last_seen_at']);
    t.index(['room_id', 'status']);
  });

  await knex.schema.createTable('alert_occurrences', (t) => {
    t.bigIncrements('id');
    t.integer('alert_id').unsigned().notNullable().references('alerts.id').onDelete('CASCADE');
    t.bigInteger('device_event_id').unsigned().nullable().references('device_events.id').onDelete('SET NULL');
    t.json('payload').nullable();
    ts(knex, t, 'occurred_at');
    t.index(['alert_id', 'occurred_at']);
  });

  await knex.schema.createTable('settings', (t) => {
    t.string('key', 64).primary();
    t.json('value').notNullable();
    t.integer('updated_by').unsigned().nullable().references('staff.id');
    ts(knex, t, 'updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });

  await knex.schema.createTable('push_subscriptions', (t) => {
    t.increments('id');
    t.integer('staff_id').unsigned().notNullable().references('staff.id').onDelete('CASCADE');
    t.string('endpoint', 500).notNullable();
    t.string('endpoint_hash', 64).notNullable().unique();
    t.json('keys').notNullable();
    ts(knex, t, 'created_at');
  });

  await knex.schema.createTable('audit_log', (t) => {
    t.bigIncrements('id');
    t.enu('actor_type', ['staff', 'guest', 'system']).notNullable();
    t.integer('staff_id').unsigned().nullable().references('staff.id');
    t.integer('guest_id').unsigned().nullable().references('guests.id');
    t.string('action', 60).notNullable();
    t.string('entity_type', 40).notNullable();
    t.string('entity_id', 40).nullable();
    t.integer('room_id').unsigned().nullable().references('rooms.id');
    t.json('details').nullable();
    t.string('ip', 64).nullable();
    ts(knex, t, 'created_at');
    t.index(['created_at']);
    t.index(['staff_id', 'created_at']);
    t.index(['action', 'created_at']);
    t.index(['room_id', 'created_at']);
  });
}

export async function down(knex) {
  for (const table of [
    'audit_log', 'push_subscriptions', 'settings', 'alert_occurrences', 'alerts', 'feedback_photos', 'feedback',
    'request_events', 'requests', 'guest_devices', 'stays', 'guests', 'device_events', 'device_states', 'devices',
    'adapters', 'rooms', 'room_types', 'floors', 'sessions', 'staff',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
