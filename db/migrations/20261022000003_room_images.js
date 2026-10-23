/** Release 3 schema: room images and photo gallery. */

export async function up(knex) {
  const hasImageUrl = await knex.schema.hasColumn('rooms', 'image_url');
  if (!hasImageUrl) {
    await knex.schema.alterTable('rooms', (t) => {
      t.text('image_url').nullable();
      t.json('images').nullable();
    });
  }
}

export async function down(knex) {
  const hasImageUrl = await knex.schema.hasColumn('rooms', 'image_url');
  if (hasImageUrl) {
    await knex.schema.alterTable('rooms', (t) => {
      t.dropColumn('image_url');
      t.dropColumn('images');
    });
  }
}
