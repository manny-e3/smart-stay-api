import { Router } from 'express';
import { db } from '../../config/db.js';
import { notFound, badRequest } from '../../core/errors.js';

const router = Router();

// GET /admin/inventory/categories
router.get('/categories', async (req, res) => {
  const categories = await db('inventory_categories').orderBy('name');
  res.json({ success: true, data: categories });
});

// GET /admin/inventory/items
router.get('/items', async (req, res) => {
  const { categoryId, lowStock } = req.query;
  const q = db('inventory_items as i')
    .leftJoin('inventory_categories as c', 'c.id', 'i.category_id')
    .select('i.*', 'c.name as category_name')
    .orderBy('i.name');

  if (categoryId) q.where('i.category_id', categoryId);
  if (lowStock === 'true') q.whereRaw('i.current_stock <= i.min_reorder_level');

  const items = await q;
  res.json({ success: true, data: items });
});

// POST /admin/inventory/items
router.post('/items', async (req, res) => {
  const { categoryId, sku, name, unit = 'pcs', parLevel = 20, minReorderLevel = 5, currentStock = 0, unitCost = 0.00, location } = req.body;
  if (!sku || !name) throw badRequest('SKU and Name are required');

  const [id] = await db('inventory_items').insert({
    category_id: categoryId || null,
    sku,
    name,
    unit,
    par_level: parLevel,
    min_reorder_level: minReorderLevel,
    current_stock: currentStock,
    unit_cost: unitCost,
    location: location || 'Central Warehouse',
  });

  res.status(201).json({ success: true, data: { id, sku, name } });
});

// POST /admin/inventory/transactions
router.post('/transactions', async (req, res) => {
  const { itemId, type, quantity, unitCost, roomId, notes } = req.body;
  if (!itemId || !type || quantity === undefined) throw badRequest('itemId, type, and quantity required');

  const item = await db('inventory_items').where({ id: itemId }).first();
  if (!item) throw notFound('Inventory Item');

  const qty = Number(quantity);
  const cost = Number(unitCost ?? item.unit_cost);
  const totalValue = Number((cost * Math.abs(qty)).toFixed(2));

  let stockDelta = qty;
  if (['room_refill', 'minibar_refill', 'wastage'].includes(type)) {
    stockDelta = -Math.abs(qty);
  } else if (type === 'purchase_intake') {
    stockDelta = Math.abs(qty);
  }

  await db.transaction(async (trx) => {
    await trx('inventory_transactions').insert({
      item_id: item.id,
      type,
      quantity: stockDelta,
      unit_cost: cost,
      total_value: totalValue,
      room_id: roomId || null,
      staff_id: req.staff?.id || null,
      notes: notes || null,
      created_at: new Date(),
    });

    const newStock = Math.max(0, Number(item.current_stock) + stockDelta);
    await trx('inventory_items').where({ id: item.id }).update({ current_stock: newStock, updated_at: new Date() });
  });

  res.json({ success: true, message: `Inventory adjusted. New stock: ${item.current_stock + stockDelta}` });
});

// POST /admin/inventory/rooms/:roomId/minibar-restock
router.post('/rooms/:roomId/minibar-restock', async (req, res) => {
  const { roomId } = req.params;
  const { items = [] } = req.body; // [{ itemId, consumedQty, chargeGuest: true }]

  const room = await db('rooms').where({ id: roomId }).first();
  if (!room) throw notFound('Room');

  const stay = await db('stays').where({ room_id: room.id, status: 'checked_in' }).first();

  await db.transaction(async (trx) => {
    let folio = null;
    if (stay) {
      folio = await trx('folios').where({ stay_id: stay.id, status: 'open' }).first();
    }

    for (const line of items) {
      const invItem = await trx('inventory_items').where({ id: line.itemId }).first();
      if (!invItem) continue;

      const consumed = Number(line.consumedQty || 1);
      // Deduct physical inventory
      await trx('inventory_transactions').insert({
        item_id: invItem.id,
        type: 'minibar_refill',
        quantity: -consumed,
        unit_cost: invItem.unit_cost,
        total_value: Number((invItem.unit_cost * consumed).toFixed(2)),
        room_id: room.id,
        staff_id: req.staff?.id || null,
        notes: `Replenished after consumption in Room ${room.number}`,
        created_at: new Date(),
      });

      await trx('inventory_items')
        .where({ id: invItem.id })
        .update({ current_stock: Math.max(0, invItem.current_stock - consumed), updated_at: new Date() });

      // If guest is checked in and folio exists, post minibar charge
      if (folio && line.chargeGuest !== false) {
        const retailPrice = Number((invItem.unit_cost * 2.5).toFixed(2)); // Standard hospitality minibar markup
        const lineTotal = retailPrice * consumed;
        const tax = Number((lineTotal * 0.075).toFixed(2));

        await trx('folio_charges').insert({
          folio_id: folio.id,
          charge_type: 'minibar',
          description: `Minibar: ${invItem.name} (x${consumed})`,
          amount: lineTotal,
          tax_amount: tax,
          posted_by_staff_id: req.staff?.id || null,
          created_at: new Date(),
        });

        await trx('folios').where({ id: folio.id }).increment('balance', lineTotal + tax);
      }
    }
  });

  res.json({ success: true, message: `Minibar for Room ${room.number} restocked and updated.` });
});

export default router;
