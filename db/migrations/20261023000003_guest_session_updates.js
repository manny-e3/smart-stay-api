export async function up(knex) {
  await knex.raw('ALTER TABLE guest_sessions MODIFY stay_id INT UNSIGNED NULL');
  await knex.raw("ALTER TABLE guest_sessions MODIFY method ENUM('access_code', 'booking_reference', 'booking_code', 'qr', 'email', 'password') NOT NULL");
}

export async function down(knex) {
  await knex.raw("ALTER TABLE guest_sessions MODIFY method ENUM('access_code', 'booking_reference') NOT NULL");
  await knex.raw('ALTER TABLE guest_sessions MODIFY stay_id INT UNSIGNED NOT NULL');
}
