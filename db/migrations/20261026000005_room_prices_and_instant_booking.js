export async function up(knex) {
  // 1. Add base_price and description to room_types if not exists
  const hasBasePriceInRoomTypes = await knex.schema.hasColumn('room_types', 'base_price');
  if (!hasBasePriceInRoomTypes) {
    await knex.schema.alterTable('room_types', (t) => {
      t.decimal('base_price', 10, 2).notNullable().defaultTo(150.00);
      t.text('description').nullable();
      t.integer('max_occupancy').notNullable().defaultTo(2);
    });
  }

  // 2. Add base_price to rooms table if not exists
  const hasBasePriceInRooms = await knex.schema.hasColumn('rooms', 'base_price');
  if (!hasBasePriceInRooms) {
    await knex.schema.alterTable('rooms', (t) => {
      t.decimal('base_price', 10, 2).nullable();
    });
  }

  // 3. Set realistic luxury rates for the default room types
  await knex('room_types').where({ name: 'Standard' }).update({
    base_price: 165.00,
    description: 'Urban luxury room with king or queen bed, high-speed Wi-Fi 6, smart lighting, and 50" 4K Smart TV.',
    max_occupancy: 2,
  });

  await knex('room_types').where({ name: 'Deluxe' }).update({
    base_price: 240.00,
    description: 'Contemporary ocean and garden view room with private balcony, rain shower, and Nespresso bar.',
    max_occupancy: 3,
  });

  await knex('room_types').where({ name: 'Suite' }).update({
    base_price: 380.00,
    description: 'Expansive executive suite with separate living area, California King bed, deep soaking tub, and smart scenes.',
    max_occupancy: 4,
  });

  // Also insert 'Presidential Suite' or 'Penthouse' if they don't exist
  const existingPenthouse = await knex('room_types').where({ name: 'Presidential Penthouse' }).first();
  if (!existingPenthouse) {
    await knex('room_types').insert({
      name: 'Presidential Penthouse',
      base_price: 750.00,
      description: 'Exclusive top-floor sanctuary with private terrace, outdoor jacuzzi, 2 king suites, and 24/7 butler service.',
      max_occupancy: 6,
    }).onConflict('name').ignore();
  }

  // Sync rooms with their room_type price
  await knex.raw(`
    UPDATE rooms r
    JOIN room_types rt ON r.room_type_id = rt.id
    SET r.base_price = rt.base_price
    WHERE r.base_price IS NULL
  `);
}

export async function down(knex) {
  const hasBasePriceInRooms = await knex.schema.hasColumn('rooms', 'base_price');
  if (hasBasePriceInRooms) {
    await knex.schema.alterTable('rooms', (t) => {
      t.dropColumn('base_price');
    });
  }

  const hasBasePriceInRoomTypes = await knex.schema.hasColumn('room_types', 'base_price');
  if (hasBasePriceInRoomTypes) {
    await knex.schema.alterTable('room_types', (t) => {
      t.dropColumn('base_price');
      t.dropColumn('description');
      t.dropColumn('max_occupancy');
    });
  }
}
