/**
 * Guest app: room controls (TV, speaker, device capabilities), cleaning requests,
 * request preferred time, private feedback photos, booking codes and QR login, preferences.
 */

export async function up(knex) {
  await knex.raw("ALTER TABLE devices MODIFY type ENUM('lock','thermostat','light','curtain','sensor','meter','phone','tv','speaker','other') NOT NULL");
  await knex.schema.alterTable('devices', (t) => {
    t.json('capabilities').nullable();
  });

  await knex.schema.alterTable('rooms', (t) => {
    t.boolean('cleaning_requested').notNullable().defaultTo(false);
    t.datetime('cleaning_requested_at', { precision: 3 }).nullable();
    t.integer('cleaning_request_id').unsigned().nullable().references('requests.id').onDelete('SET NULL');
  });

  await knex.schema.alterTable('requests', (t) => {
    t.datetime('preferred_at', { precision: 3 }).nullable();
  });

  await knex.schema.alterTable('feedback', (t) => {
    t.boolean('is_issue').notNullable().defaultTo(false);
  });
  await knex.raw('ALTER TABLE feedback_photos MODIFY url VARCHAR(500) NULL');
  await knex.schema.alterTable('feedback_photos', (t) => {
    t.string('storage_key', 200).nullable();
    t.string('content_type', 60).nullable();
    t.integer('size_bytes').nullable();
  });

  // Booking codes and QR tokens are looked up by a keyed hash; only one live code may have a given hash.
  await knex.raw('ALTER TABLE guest_access_codes MODIFY code_hash VARCHAR(64) NULL');
  await knex.schema.alterTable('guest_access_codes', (t) => {
    t.enu('kind', ['code', 'qr']).notNullable().defaultTo('code');
    t.string('lookup_hash', 64).nullable();
  });
  await knex.raw('UPDATE guest_access_codes SET revoked_at = CURRENT_TIMESTAMP(3) WHERE revoked_at IS NULL');
  await knex.raw('ALTER TABLE guest_access_codes ADD COLUMN active_lookup VARCHAR(64) GENERATED ALWAYS AS (IF(revoked_at IS NULL, lookup_hash, NULL)) STORED');
  await knex.raw('ALTER TABLE guest_access_codes ADD UNIQUE INDEX guest_access_active_lookup_unique (active_lookup)');
  await knex.raw("ALTER TABLE guest_sessions MODIFY method ENUM('access_code','booking_reference','booking_code','qr') NOT NULL");

  await knex.schema.createTable('guest_preferences', (t) => {
    t.integer('guest_id').unsigned().primary().references('guests.id').onDelete('CASCADE');
    t.json('preferences').notNullable();
    t.datetime('updated_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('guest_preferences');
  await knex.raw("UPDATE guest_sessions SET method = 'access_code' WHERE method IN ('booking_code','qr')");
  await knex.raw("ALTER TABLE guest_sessions MODIFY method ENUM('access_code','booking_reference') NOT NULL");
  await knex.raw('ALTER TABLE guest_access_codes DROP INDEX guest_access_active_lookup_unique');
  await knex.raw('ALTER TABLE guest_access_codes DROP COLUMN active_lookup');
  await knex.raw('DELETE FROM guest_access_codes WHERE code_hash IS NULL');
  await knex.schema.alterTable('guest_access_codes', (t) => {
    t.dropColumn('kind');
    t.dropColumn('lookup_hash');
  });
  await knex.raw('ALTER TABLE guest_access_codes MODIFY code_hash VARCHAR(64) NOT NULL');
  await knex.schema.alterTable('feedback_photos', (t) => {
    t.dropColumn('storage_key');
    t.dropColumn('content_type');
    t.dropColumn('size_bytes');
  });
  await knex.raw("UPDATE feedback_photos SET url = '' WHERE url IS NULL");
  await knex.raw('ALTER TABLE feedback_photos MODIFY url VARCHAR(500) NOT NULL');
  await knex.schema.alterTable('feedback', (t) => t.dropColumn('is_issue'));
  await knex.schema.alterTable('requests', (t) => t.dropColumn('preferred_at'));
  await knex.schema.alterTable('rooms', (t) => {
    t.dropForeign(['cleaning_request_id']);
    t.dropColumn('cleaning_request_id');
    t.dropColumn('cleaning_requested_at');
    t.dropColumn('cleaning_requested');
  });
  await knex.schema.alterTable('devices', (t) => t.dropColumn('capabilities'));
  await knex.raw("UPDATE devices SET type = 'other' WHERE type IN ('tv','speaker')");
  await knex.raw("ALTER TABLE devices MODIFY type ENUM('lock','thermostat','light','curtain','sensor','meter','phone','other') NOT NULL");
}
