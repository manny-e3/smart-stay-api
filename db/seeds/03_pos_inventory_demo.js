export async function seed(knex) {
  // 1. Ensure Smart Dustbin sensors exist for all rooms
  const rooms = await knex('rooms').select('id', 'number');
  const adapter = await knex('adapters').first('id');
  const adapterId = adapter ? adapter.id : 1;

  for (const r of rooms) {
    const existing = await knex('devices').where({ room_id: r.id, name: 'Smart Dustbin' }).first('id');
    if (!existing) {
      // Create some with high fill level to test alerts (e.g. room 103 or 204)
      const fill = (r.number === '103' || r.number === '204') ? 89 : (20 + (r.id * 7) % 55);
      const [devId] = await knex('devices').insert({
        adapter_id: adapterId,
        external_id: `bin-waste-${r.number}`,
        room_id: r.id,
        type: 'sensor',
        name: 'Smart Dustbin',
        capabilities: JSON.stringify({ subType: 'waste_bin', thresholdPercent: 85, volumeLiters: 25 }),
      });
      await knex('device_states').insert({
        device_id: devId,
        online: true,
        state: JSON.stringify({
          fillLevel: fill,
          battery: 92,
          lidOpen: false,
          lastEmptiedAt: new Date(Date.now() - (r.id * 3600000)),
        }),
        last_seen_at: new Date(),
      });
    }
  }

  // 2. POS Outlets & Menu Items
  const outletsCount = await knex('pos_outlets').count({ n: '*' }).first();
  if (outletsCount.n === 0) {
    const [palmId] = await knex('pos_outlets').insert({
      name: 'The Palm Terrace Restaurant',
      code: 'OUT-PALM',
      opening_hours: '06:30 - 23:00',
      is_active: true,
    });
    const [barId] = await knex('pos_outlets').insert({
      name: 'Skyline Lounge & Cocktail Bar',
      code: 'OUT-BAR',
      opening_hours: '16:00 - 02:00',
      is_active: true,
    });
    const [irdId] = await knex('pos_outlets').insert({
      name: 'In-Room Dining Kitchen',
      code: 'OUT-IRD',
      opening_hours: '24 Hours',
      is_active: true,
    });

    // Categories
    const [catMains] = await knex('pos_categories').insert({ outlet_id: palmId, name: 'Mains & Chef Specialties', display_order: 1 });
    const [catStarters] = await knex('pos_categories').insert({ outlet_id: palmId, name: 'Starters & Salads', display_order: 2 });
    const [catCocktails] = await knex('pos_categories').insert({ outlet_id: barId, name: 'Signature Cocktails', display_order: 1 });
    const [catDessert] = await knex('pos_categories').insert({ outlet_id: palmId, name: 'Artisanal Desserts', display_order: 3 });
    const [catIrd] = await knex('pos_categories').insert({ outlet_id: irdId, name: 'All-Day Dining', display_order: 1 });

    // Menu items
    const menuItems = [
      { outlet_id: palmId, category_id: catMains, sku: 'PALM-STEAK-01', name: 'Dry-Aged Wagyu Ribeye', price: 68.00, cost_price: 24.00, dietary_tags: JSON.stringify(['Gluten-Free', 'Halal']), description: '300g Prime Ribeye served with truffle potato mousseline and red wine jus.' },
      { outlet_id: palmId, category_id: catMains, sku: 'PALM-SALMON-02', name: 'Pan-Seared Scottish Salmon', price: 42.00, cost_price: 14.50, dietary_tags: JSON.stringify(['Gluten-Free']), description: 'Crispy skin salmon, asparagus velouté, and citrus gremolata.' },
      { outlet_id: palmId, category_id: catStarters, sku: 'PALM-BURR-01', name: 'Heritage Truffle Burrata', price: 24.00, cost_price: 7.20, dietary_tags: JSON.stringify(['Vegetarian']), description: 'Heirloom tomatoes, balsamic caviar, basil emulsion.' },
      { outlet_id: palmId, category_id: catDessert, sku: 'PALM-SOUF-01', name: 'Valrhona Chocolate Fondant', price: 18.00, cost_price: 4.80, dietary_tags: JSON.stringify(['Vegetarian']), description: 'Warm molten center with Madagascar bourbon vanilla gelato.' },
      { outlet_id: barId, category_id: catCocktails, sku: 'BAR-MART-01', name: 'Golden Truffle Martini', price: 26.00, cost_price: 5.50, dietary_tags: JSON.stringify([]), description: 'Grey Goose, dry vermouth, white truffle mist, 24k gold leaf.' },
      { outlet_id: barId, category_id: catCocktails, sku: 'BAR-SMOK-02', name: 'Smoked Mezcal Old Fashioned', price: 22.00, cost_price: 4.20, dietary_tags: JSON.stringify([]), description: 'Handcrafted mezcal, agave nectar, flamed orange peel, smoked cedar.' },
      { outlet_id: irdId, category_id: catIrd, sku: 'IRD-BURG-01', name: 'Serene Grand Burger', price: 32.00, cost_price: 9.00, dietary_tags: JSON.stringify([]), description: 'Angus patty, aged cheddar, caramelized shallots, brioche, truffle fries.' },
      { outlet_id: irdId, category_id: catIrd, sku: 'IRD-CLUB-02', name: 'Smoked Turkey Club Sandwich', price: 26.00, cost_price: 6.80, dietary_tags: JSON.stringify([]), description: 'Avocado, heirloom tomato, bacon, herb aioli, toasted sourdough.' },
    ];
    for (const item of menuItems) {
      await knex('pos_menu_items').insert(item);
    }
  }

  // 3. Physical Stock Inventory & Categories
  const invCount = await knex('inventory_categories').count({ n: '*' }).first();
  if (invCount.n === 0) {
    const [catLinen] = await knex('inventory_categories').insert({ name: 'Linens & Bedding', description: 'Bed sheets, duvet covers, pillow slips, plush towels' });
    const [catMinibar] = await knex('inventory_categories').insert({ name: 'Minibar & Refreshments', description: 'Soft drinks, champagne, spirits, gourmet snacks' });
    const [catAmenities] = await knex('inventory_categories').insert({ name: 'Guest Toiletries', description: 'Acqua di Parma shampoo, conditioner, dental kits' });

    const invItems = [
      { category_id: catLinen, sku: 'LIN-KING-SHEET', name: '800-TC King Duvet Cover (White)', unit: 'pcs', par_level: 60, min_reorder_level: 15, current_stock: 48, unit_cost: 38.50 },
      { category_id: catLinen, sku: 'LIN-BATH-SHEET', name: 'Luxury Cotton Bath Towel', unit: 'pcs', par_level: 120, min_reorder_level: 30, current_stock: 22, unit_cost: 16.00 },
      { category_id: catMinibar, sku: 'MNB-DOM-PERI', name: 'Dom Pérignon Vintage Champagne (750ml)', unit: 'bottles', par_level: 24, min_reorder_level: 6, current_stock: 14, unit_cost: 185.00 },
      { category_id: catMinibar, sku: 'MNB-SAN-PELLE', name: 'San Pellegrino Sparkling Water (500ml)', unit: 'bottles', par_level: 200, min_reorder_level: 40, current_stock: 135, unit_cost: 2.10 },
      { category_id: catAmenities, sku: 'AMN-SHAMP-50', name: 'Acqua di Parma Shampoo (50ml)', unit: 'bottles', par_level: 300, min_reorder_level: 50, current_stock: 45, unit_cost: 3.40 },
      { category_id: catAmenities, sku: 'AMN-DENT-01', name: 'Bamboo Dental Hygiene Kit', unit: 'kits', par_level: 250, min_reorder_level: 50, current_stock: 180, unit_cost: 1.20 },
    ];
    for (const item of invItems) {
      await knex('inventory_items').insert(item);
    }
  }

  // 4. Vendors & Procurement POs
  const vendorCount = await knex('vendors').count({ n: '*' }).first();
  if (vendorCount.n === 0) {
    const [v1] = await knex('vendors').insert({
      company_name: 'Bellora Italian Luxury Linens',
      contact_name: 'Marco Bellora',
      email: 'orders@bellora-textiles.com',
      phone: '+39 02 8901 234',
      tax_id: 'IT-9823412',
      payment_terms: 'Net 30',
      rating: 4.9,
    });
    const [v2] = await knex('vendors').insert({
      company_name: 'Grand Cru Beverage Distributors',
      contact_name: 'Claire Dupont',
      email: 'hospitality@grandcru-wines.com',
      phone: '+33 1 45 67 89 00',
      tax_id: 'FR-8839201',
      payment_terms: 'Net 15',
      rating: 4.8,
    });

    const staffMember = await knex('staff').first('id');
    const staffId = staffMember ? staffMember.id : null;

    await knex('purchase_orders').insert({
      po_number: 'PO-2026-001',
      vendor_id: v1,
      status: 'received',
      total_amount: 1420.00,
      expected_delivery_date: new Date(Date.now() - 86400000 * 3),
      created_by_staff_id: staffId,
      approved_by_staff_id: staffId,
      notes: 'Quarterly replenish of master suite Egyptian cotton linens.',
    });
    await knex('purchase_orders').insert({
      po_number: 'PO-2026-002',
      vendor_id: v2,
      status: 'ordered',
      total_amount: 2250.00,
      expected_delivery_date: new Date(Date.now() + 86400000 * 2),
      created_by_staff_id: staffId,
      notes: 'Minibar replenishment for VIP arrival weekend.',
    });
  }

  // 5. Folios for existing active Stays
  const checkedInStays = await knex('stays').where('status', 'checked_in').select('id', 'guest_id', 'room_id', 'reference');
  for (const s of checkedInStays) {
    const existingFolio = await knex('folios').where({ stay_id: s.id }).first('id');
    if (!existingFolio) {
      const [folioId] = await knex('folios').insert({
        stay_id: s.id,
        guest_id: s.guest_id,
        folio_number: `FOL-${s.reference || s.id}`,
        status: 'open',
        currency: 'USD',
        balance: 485.00,
      });
      // Initial Room Rate Charge
      await knex('folio_charges').insert([
        { folio_id: folioId, charge_type: 'room_rate', description: 'Night 1 Room Accommodation Rate', amount: 350.00, tax_amount: 26.25 },
        { folio_id: folioId, charge_type: 'tax', description: 'State Tourism & Occupancy Levy (7.5%)', amount: 26.25, tax_amount: 0.00 },
        { folio_id: folioId, charge_type: 'pos_fnb', description: 'Palm Terrace Dining - Bill #POS-8821', amount: 98.00, tax_amount: 7.35 },
        { folio_id: folioId, charge_type: 'tax', description: 'F&B Sales Tax (7.5%)', amount: 7.35, tax_amount: 0.00 },
        { folio_id: folioId, charge_type: 'minibar', description: 'San Pellegrino x2 + Champagne Restock', amount: 29.50, tax_amount: 2.21 },
      ]);
    }
  }
}
