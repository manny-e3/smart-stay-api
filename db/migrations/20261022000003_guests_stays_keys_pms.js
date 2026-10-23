/**
 * Guests and bookings: stay lifecycle, companions, stay history, guest app access,
 * digital keys and PMS (property management system) sync.
 */

const now3 = (knex) => knex.raw('CURRENT_TIMESTAMP(3)');

export async function up(knex) {
  // ---- stays -----------------------------------------------------------
  await knex.raw("ALTER TABLE stays MODIFY status ENUM('reserved','checked_in','checked_out','cancelled','no_show') NOT NULL DEFAULT 'reserved'");
  await knex.raw('ALTER TABLE stays MODIFY room_id INT UNSIGNED NULL');
  await knex.schema.alterTable('stays', (t) => {
    t.string('reference', 20).nullable().unique();
    t.enu('source', ['manual', 'pms']).notNullable().defaultTo('manual');
    t.integer('pms_connection_id').unsigned().nullable();
    t.string('external_id', 100).nullable();
    t.integer('room_type_id').unsigned().nullable().references('room_types.id');
    t.datetime('checked_in_at', { precision: 3 }).nullable();
    t.datetime('checked_out_at', { precision: 3 }).nullable();
    t.integer('adults').notNullable().defaultTo(1);
    t.integer('children').notNullable().defaultTo(0);
    t.string('notes', 1000).nullable();
    t.integer('created_by').unsigned().nullable().references('staff.id');
    t.integer('access_failures').notNullable().defaultTo(0);
    t.datetime('access_locked_until', { precision: 3 }).nullable();
    t.datetime('pms_synced_at', { precision: 3 }).nullable();
    t.unique(['pms_connection_id', 'external_id']);
    t.index(['status', 'check_in_at']);
    t.index(['status', 'check_out_at']);
  });
  await knex.raw("UPDATE stays SET adults = GREATEST(guest_count, 1), reference = CONCAT('SS', LPAD(id, 6, '0')) WHERE reference IS NULL");
  await knex.raw("UPDATE stays SET checked_in_at = check_in_at WHERE status IN ('checked_in','checked_out') AND checked_in_at IS NULL");
  await knex.raw("UPDATE stays SET checked_out_at = updated_at WHERE status = 'checked_out' AND checked_out_at IS NULL");
  await knex.schema.alterTable('stays', (t) => t.dropColumn('guest_count'));
  // Database-level guarantee: a room can have only one checked-in stay.
  await knex.raw("ALTER TABLE stays ADD COLUMN active_room_id INT UNSIGNED GENERATED ALWAYS AS (IF(status = 'checked_in', room_id, NULL)) STORED");
  await knex.raw('ALTER TABLE stays ADD UNIQUE INDEX stays_active_room_unique (active_room_id)');

  // ---- guests and rooms ------------------------------------------------
  await knex.schema.alterTable('guests', (t) => {
    t.integer('pms_connection_id').unsigned().nullable();
    t.string('external_id', 100).nullable();
    t.boolean('vip').notNullable().defaultTo(false);
    t.string('notes', 1000).nullable();
    t.datetime('anonymized_at', { precision: 3 }).nullable();
    t.unique(['pms_connection_id', 'external_id']);
    t.index(['last_name']);
    t.index(['email']);
  });
  await knex.schema.alterTable('rooms', (t) => {
    t.string('pms_code', 40).nullable().unique();
  });

  // ---- companions and history -----------------------------------------
  await knex.schema.createTable('stay_guests', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.integer('guest_id').unsigned().notNullable().references('guests.id').onDelete('CASCADE');
    t.boolean('is_primary').notNullable().defaultTo(false);
    t.unique(['stay_id', 'guest_id']);
  });
  await knex.raw('INSERT INTO stay_guests (stay_id, guest_id, is_primary) SELECT id, guest_id, 1 FROM stays');

  await knex.schema.createTable('stay_events', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.enu('actor_type', ['staff', 'guest', 'system', 'pms']).notNullable();
    t.integer('staff_id').unsigned().nullable().references('staff.id');
    t.string('action', 40).notNullable();
    t.integer('from_room_id').unsigned().nullable().references('rooms.id');
    t.integer('to_room_id').unsigned().nullable().references('rooms.id');
    t.string('note', 1000).nullable();
    t.json('data').nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.index(['stay_id', 'created_at']);
  });

  // ---- guest app access ------------------------------------------------
  await knex.schema.createTable('guest_access_codes', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.string('code_hash', 64).notNullable();
    t.integer('created_by').unsigned().nullable().references('staff.id');
    t.datetime('revoked_at', { precision: 3 }).nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.index(['stay_id', 'revoked_at']);
  });

  await knex.schema.createTable('guest_sessions', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.integer('guest_id').unsigned().notNullable().references('guests.id').onDelete('CASCADE');
    t.enu('method', ['access_code', 'booking_reference']).notNullable();
    t.string('user_agent', 255).nullable();
    t.string('ip', 64).nullable();
    t.datetime('expires_at', { precision: 3 }).notNullable();
    t.datetime('revoked_at', { precision: 3 }).nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.index(['stay_id', 'revoked_at']);
  });

  // ---- digital keys ------------------------------------------------------
  await knex.schema.createTable('digital_keys', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.integer('device_id').unsigned().notNullable().references('devices.id');
    t.integer('room_id').unsigned().notNullable().references('rooms.id');
    t.string('external_key_id', 190).nullable();
    t.text('credential_encrypted').nullable();
    t.enu('status', ['active', 'revoked', 'failed', 'revoke_failed']).notNullable();
    t.datetime('valid_from', { precision: 3 }).notNullable();
    t.datetime('valid_until', { precision: 3 }).notNullable();
    t.string('last_error', 500).nullable();
    t.datetime('issued_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.datetime('revoked_at', { precision: 3 }).nullable();
    t.index(['stay_id', 'status']);
  });

  // ---- PMS sync ----------------------------------------------------------
  await knex.schema.createTable('pms_connections', (t) => {
    t.increments('id');
    t.string('name', 80).notNullable().unique();
    t.string('vendor', 40).notNullable();
    t.json('config').nullable();
    t.string('webhook_secret_hash', 64).nullable();
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.enu('status', ['unknown', 'healthy', 'degraded', 'down']).notNullable().defaultTo('unknown');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.datetime('last_sync_at', { precision: 3 }).nullable();
    t.string('last_sync_result', 500).nullable();
    t.datetime('last_error_at', { precision: 3 }).nullable();
    t.string('last_error', 500).nullable();
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.datetime('updated_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });

  await knex.schema.createTable('pms_events', (t) => {
    t.bigIncrements('id');
    t.integer('connection_id').unsigned().notNullable().references('pms_connections.id').onDelete('CASCADE');
    t.string('external_event_id', 190).notNullable();
    t.string('event_type', 40).notNullable();
    t.json('payload').notNullable();
    t.enu('status', ['pending', 'processed', 'ignored', 'failed']).notNullable().defaultTo('pending');
    t.string('result', 500).nullable();
    t.datetime('occurred_at', { precision: 3 }).nullable();
    t.datetime('received_at', { precision: 3 }).notNullable().defaultTo(now3(knex));
    t.datetime('processed_at', { precision: 3 }).nullable();
    t.unique(['connection_id', 'external_event_id']);
    t.index(['status', 'received_at']);
  });

  await knex.raw('ALTER TABLE stays ADD CONSTRAINT stays_pms_connection_fk FOREIGN KEY (pms_connection_id) REFERENCES pms_connections(id) ON DELETE SET NULL');
  await knex.raw('ALTER TABLE guests ADD CONSTRAINT guests_pms_connection_fk FOREIGN KEY (pms_connection_id) REFERENCES pms_connections(id) ON DELETE SET NULL');
}

export async function down(knex) {
  await knex.raw('ALTER TABLE guests DROP FOREIGN KEY guests_pms_connection_fk');
  await knex.raw('ALTER TABLE stays DROP FOREIGN KEY stays_pms_connection_fk');
  for (const t of ['pms_events', 'pms_connections', 'digital_keys', 'guest_sessions', 'guest_access_codes', 'stay_events', 'stay_guests']) {
    await knex.schema.dropTableIfExists(t);
  }
  await knex.schema.alterTable('rooms', (t) => t.dropColumn('pms_code'));
  await knex.schema.alterTable('guests', (t) => {
    t.dropUnique(['pms_connection_id', 'external_id']);
    t.dropIndex(['last_name']);
    t.dropIndex(['email']);
    t.dropColumn('pms_connection_id');
    t.dropColumn('external_id');
    t.dropColumn('vip');
    t.dropColumn('notes');
    t.dropColumn('anonymized_at');
  });
  await knex.raw('ALTER TABLE stays DROP INDEX stays_active_room_unique');
  await knex.raw('ALTER TABLE stays DROP COLUMN active_room_id');
  await knex.schema.alterTable('stays', (t) => {
    t.integer('guest_count').notNullable().defaultTo(1);
  });
  await knex.raw('UPDATE stays SET guest_count = adults + children');
  await knex.schema.alterTable('stays', (t) => {
    t.dropUnique(['pms_connection_id', 'external_id']);
    t.dropIndex(['status', 'check_in_at']);
    t.dropIndex(['status', 'check_out_at']);
    t.dropForeign(['room_type_id']);
    t.dropForeign(['created_by']);
    for (const c of ['reference', 'source', 'pms_connection_id', 'external_id', 'room_type_id', 'checked_in_at', 'checked_out_at', 'adults', 'children', 'notes', 'created_by', 'access_failures', 'access_locked_until', 'pms_synced_at']) t.dropColumn(c);
  });
  await knex.raw("UPDATE stays SET status = 'checked_out' WHERE status IN ('cancelled','no_show')");
  await knex.raw("ALTER TABLE stays MODIFY status ENUM('reserved','checked_in','checked_out') NOT NULL DEFAULT 'reserved'");
}
