/**
 * Guest passwords and password reset tokens.
 */
export async function up(knex) {
  await knex.schema.alterTable('guests', (t) => {
    t.string('password_hash', 255).nullable();
    t.string('reset_token', 100).nullable();
    t.datetime('reset_expires_at', { precision: 3 }).nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable('guests', (t) => {
    t.dropColumn('password_hash');
    t.dropColumn('reset_token');
    t.dropColumn('reset_expires_at');
  });
}
