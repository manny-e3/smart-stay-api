/**
 * Migration: POS, Physical Inventory, Procurement, Folio Ledger, and Waste Bin Sensors
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
  // 1. POS Outlets & Menus
  await knex.schema.createTable('pos_outlets', (t) => {
    t.increments('id');
    t.string('name', 120).notNullable();
    t.string('code', 40).notNullable().unique();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.string('opening_hours', 100).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('pos_categories', (t) => {
    t.increments('id');
    t.integer('outlet_id').unsigned().notNullable().references('pos_outlets.id').onDelete('CASCADE');
    t.string('name', 80).notNullable();
    t.integer('display_order').notNullable().defaultTo(0);
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('pos_menu_items', (t) => {
    t.increments('id');
    t.integer('outlet_id').unsigned().notNullable().references('pos_outlets.id').onDelete('CASCADE');
    t.integer('category_id').unsigned().nullable().references('pos_categories.id').onDelete('SET NULL');
    t.string('sku', 60).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('description', 500).nullable();
    t.decimal('price', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('cost_price', 10, 2).nullable().defaultTo(0.00);
    t.decimal('tax_rate', 5, 2).notNullable().defaultTo(7.50);
    t.json('dietary_tags').nullable();
    t.json('allergens').nullable();
    t.string('image_url', 300).nullable();
    t.boolean('is_available').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('pos_orders', (t) => {
    t.increments('id');
    t.integer('outlet_id').unsigned().notNullable().references('pos_outlets.id').onDelete('CASCADE');
    t.integer('stay_id').unsigned().nullable().references('stays.id').onDelete('SET NULL');
    t.integer('room_id').unsigned().nullable().references('rooms.id').onDelete('SET NULL');
    t.integer('server_staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    t.string('order_number', 60).notNullable().unique();
    t.enu('order_type', ['dine_in', 'room_service', 'takeaway', 'bar']).notNullable().defaultTo('dine_in');
    t.string('table_or_room', 60).nullable();
    t.enu('status', ['draft', 'sent_to_kitchen', 'preparing', 'served', 'completed', 'voided']).notNullable().defaultTo('draft');
    t.decimal('subtotal', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('tax_amount', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('service_charge', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('discount_amount', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('tip_amount', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('total_amount', 10, 2).notNullable().defaultTo(0.00);
    t.enu('payment_status', ['unpaid', 'paid', 'posted_to_room', 'voided']).notNullable().defaultTo('unpaid');
    t.string('notes', 300).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('pos_order_items', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('pos_orders.id').onDelete('CASCADE');
    t.integer('menu_item_id').unsigned().nullable().references('pos_menu_items.id').onDelete('SET NULL');
    t.string('item_name', 120).notNullable();
    t.integer('quantity').notNullable().defaultTo(1);
    t.decimal('unit_price', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('total_price', 10, 2).notNullable().defaultTo(0.00);
    t.string('special_instructions', 255).nullable();
    t.enu('status', ['pending', 'cooking', 'served', 'cancelled']).notNullable().defaultTo('pending');
    timestamps(knex, t);
  });

  await knex.schema.createTable('pos_payments', (t) => {
    t.increments('id');
    t.integer('order_id').unsigned().notNullable().references('pos_orders.id').onDelete('CASCADE');
    t.enu('payment_method', ['cash', 'card', 'room_folio', 'complimentary']).notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.string('reference_code', 100).nullable();
    t.integer('processed_by_staff_id').unsigned().nullable().references('staff.id');
    ts(knex, t, 'processed_at');
    timestamps(knex, t);
  });

  // 2. Physical Stock Inventory
  await knex.schema.createTable('inventory_categories', (t) => {
    t.increments('id');
    t.string('name', 80).notNullable().unique();
    t.string('description', 255).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('inventory_items', (t) => {
    t.increments('id');
    t.integer('category_id').unsigned().nullable().references('inventory_categories.id').onDelete('SET NULL');
    t.string('sku', 60).notNullable().unique();
    t.string('name', 120).notNullable();
    t.string('unit', 30).notNullable().defaultTo('pcs');
    t.integer('par_level').notNullable().defaultTo(20);
    t.integer('min_reorder_level').notNullable().defaultTo(5);
    t.integer('current_stock').notNullable().defaultTo(0);
    t.decimal('unit_cost', 10, 2).notNullable().defaultTo(0.00);
    t.string('location', 100).nullable().defaultTo('Central Warehouse');
    timestamps(knex, t);
  });

  await knex.schema.createTable('inventory_transactions', (t) => {
    t.increments('id');
    t.integer('item_id').unsigned().notNullable().references('inventory_items.id').onDelete('CASCADE');
    t.enu('type', ['purchase_intake', 'room_refill', 'minibar_refill', 'wastage', 'adjustment']).notNullable();
    t.integer('quantity').notNullable();
    t.decimal('unit_cost', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('total_value', 10, 2).notNullable().defaultTo(0.00);
    t.integer('room_id').unsigned().nullable().references('rooms.id').onDelete('SET NULL');
    t.integer('staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    t.string('notes', 300).nullable();
    ts(knex, t, 'created_at');
  });

  // 3. Procurement & Vendors
  await knex.schema.createTable('vendors', (t) => {
    t.increments('id');
    t.string('company_name', 140).notNullable();
    t.string('contact_name', 100).nullable();
    t.string('email', 140).nullable();
    t.string('phone', 40).nullable();
    t.string('tax_id', 60).nullable();
    t.string('payment_terms', 60).nullable().defaultTo('Net 30');
    t.decimal('rating', 3, 1).nullable().defaultTo(4.5);
    t.string('address', 255).nullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    timestamps(knex, t);
  });

  await knex.schema.createTable('purchase_orders', (t) => {
    t.increments('id');
    t.string('po_number', 60).notNullable().unique();
    t.integer('vendor_id').unsigned().notNullable().references('vendors.id').onDelete('CASCADE');
    t.enu('status', ['draft', 'pending_approval', 'ordered', 'partially_received', 'received', 'cancelled']).notNullable().defaultTo('draft');
    t.decimal('total_amount', 10, 2).notNullable().defaultTo(0.00);
    t.date('expected_delivery_date').nullable();
    t.integer('created_by_staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    t.integer('approved_by_staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    t.string('notes', 400).nullable();
    timestamps(knex, t);
  });

  await knex.schema.createTable('purchase_order_items', (t) => {
    t.increments('id');
    t.integer('po_id').unsigned().notNullable().references('purchase_orders.id').onDelete('CASCADE');
    t.integer('item_id').unsigned().notNullable().references('inventory_items.id').onDelete('CASCADE');
    t.integer('ordered_quantity').notNullable();
    t.integer('received_quantity').notNullable().defaultTo(0);
    t.decimal('unit_price', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('total_price', 10, 2).notNullable().defaultTo(0.00);
    timestamps(knex, t);
  });

  // 4. Finance & Folio Ledger
  await knex.schema.createTable('folios', (t) => {
    t.increments('id');
    t.integer('stay_id').unsigned().notNullable().references('stays.id').onDelete('CASCADE');
    t.integer('guest_id').unsigned().notNullable().references('guests.id').onDelete('CASCADE');
    t.string('folio_number', 60).notNullable().unique();
    t.enu('status', ['open', 'settled', 'closed']).notNullable().defaultTo('open');
    t.string('currency', 10).notNullable().defaultTo('USD');
    t.decimal('balance', 10, 2).notNullable().defaultTo(0.00);
    timestamps(knex, t);
  });

  await knex.schema.createTable('folio_charges', (t) => {
    t.increments('id');
    t.integer('folio_id').unsigned().notNullable().references('folios.id').onDelete('CASCADE');
    t.enu('charge_type', ['room_rate', 'pos_fnb', 'minibar', 'laundry', 'spa', 'late_checkout', 'damage', 'tax', 'service_charge', 'discount']).notNullable();
    t.string('description', 200).notNullable();
    t.decimal('amount', 10, 2).notNullable().defaultTo(0.00);
    t.decimal('tax_amount', 10, 2).notNullable().defaultTo(0.00);
    t.string('reference_id', 60).nullable();
    t.integer('posted_by_staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    ts(knex, t, 'created_at');
  });

  await knex.schema.createTable('folio_payments', (t) => {
    t.increments('id');
    t.integer('folio_id').unsigned().notNullable().references('folios.id').onDelete('CASCADE');
    t.enu('payment_method', ['credit_card', 'cash', 'bank_transfer', 'crypto']).notNullable();
    t.decimal('amount', 10, 2).notNullable();
    t.string('transaction_reference', 100).nullable();
    t.string('card_last_four', 10).nullable();
    t.string('auth_code', 50).nullable();
    ts(knex, t, 'settled_at');
    t.integer('staff_id').unsigned().nullable().references('staff.id').onDelete('SET NULL');
    timestamps(knex, t);
  });
}

export async function down(knex) {
  for (const table of [
    'folio_payments', 'folio_charges', 'folios',
    'purchase_order_items', 'purchase_orders', 'vendors',
    'inventory_transactions', 'inventory_items', 'inventory_categories',
    'pos_payments', 'pos_order_items', 'pos_orders', 'pos_menu_items', 'pos_categories', 'pos_outlets'
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
