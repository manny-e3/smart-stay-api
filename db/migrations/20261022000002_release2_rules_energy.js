/** Release 2 schema: schedules and vacancy rules, rule run history, energy readings. */

export async function up(knex) {
  await knex.schema.createTable('rules', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.enu('type', ['schedule', 'vacancy']).notNullable();
    t.boolean('is_enabled').notNullable().defaultTo(true);
    t.string('cron', 120).nullable();
    t.json('target').notNullable();
    t.json('conditions').nullable();
    t.json('actions').notNullable();
    t.datetime('last_run_at', { precision: 3 }).nullable();
    t.string('last_run_status', 20).nullable();
    t.integer('created_by').unsigned().nullable().references('staff.id');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.datetime('updated_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));
  });

  await knex.schema.createTable('rule_runs', (t) => {
    t.increments('id');
    t.integer('rule_id').unsigned().notNullable().references('rules.id').onDelete('CASCADE');
    t.enu('trigger', ['schedule', 'vacancy', 'manual']).notNullable();
    t.enu('status', ['running', 'success', 'partial', 'failed', 'skipped']).notNullable().defaultTo('running');
    t.integer('rooms_matched').notNullable().defaultTo(0);
    t.integer('commands_sent').notNullable().defaultTo(0);
    t.integer('commands_failed').notNullable().defaultTo(0);
    t.json('details').nullable();
    t.integer('triggered_by').unsigned().nullable().references('staff.id');
    t.datetime('started_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.datetime('finished_at', { precision: 3 }).nullable();
    t.index(['rule_id', 'started_at']);
  });

  await knex.schema.createTable('energy_readings', (t) => {
    t.bigIncrements('id');
    t.integer('room_id').unsigned().notNullable().references('rooms.id');
    t.integer('device_id').unsigned().nullable().references('devices.id').onDelete('SET NULL');
    t.datetime('period_start', { precision: 0 }).notNullable();
    t.decimal('kwh', 12, 4).notNullable();
    t.string('source', 40).notNullable().defaultTo('adapter');
    t.datetime('created_at', { precision: 3 }).notNullable().defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
    t.unique(['room_id', 'device_id', 'period_start']);
    t.index(['period_start']);
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('energy_readings');
  await knex.schema.dropTableIfExists('rule_runs');
  await knex.schema.dropTableIfExists('rules');
}
