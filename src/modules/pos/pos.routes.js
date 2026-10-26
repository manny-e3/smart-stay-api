import { Router } from 'express';
import { db } from '../../config/db.js';
import { notFound, badRequest } from '../../core/errors.js';
import { bus, EVENTS } from '../../core/events.js';

const router = Router();

// GET /admin/pos/outlets
router.get('/outlets', async (req, res) => {
  const outlets = await db('pos_outlets').where({ is_active: true }).orderBy('name');
  res.json({ success: true, data: outlets });
});

// GET /admin/pos/categories
router.get('/categories', async (req, res) => {
  const { outletId } = req.query;
  const q = db('pos_categories').where({ is_active: true }).orderBy('display_order');
  if (outletId) q.where({ outlet_id: outletId });
  const categories = await q;
  res.json({ success: true, data: categories });
});

// GET /admin/pos/menu
router.get('/menu', async (req, res) => {
  const { outletId, categoryId } = req.query;
  const q = db('pos_menu_items as m')
    .leftJoin('pos_categories as c', 'c.id', 'm.category_id')
    .leftJoin('pos_outlets as o', 'o.id', 'm.outlet_id')
    .select('m.*', 'c.name as category_name', 'o.name as outlet_name')
    .where('m.is_available', true);
  if (outletId) q.where('m.outlet_id', outletId);
  if (categoryId) q.where('m.category_id', categoryId);
  const items = await q;
  res.json({ success: true, data: items });
});

// GET /admin/pos/orders
router.get('/orders', async (req, res) => {
  const { status, outletId, limit = 50 } = req.query;
  const q = db('pos_orders as o')
    .leftJoin('pos_outlets as out', 'out.id', 'o.outlet_id')
    .leftJoin('staff as st', 'st.id', 'o.server_staff_id')
    .select('o.*', 'out.name as outlet_name', 'st.name as server_name')
    .orderBy('o.created_at', 'desc')
    .limit(Number(limit));
  if (status) q.where('o.status', status);
  if (outletId) q.where('o.outlet_id', outletId);
  const orders = await q;
  res.json({ success: true, data: orders });
});

// POST /admin/pos/orders
router.post('/orders', async (req, res) => {
  const { outletId, stayId, roomId, orderType = 'dine_in', tableOrRoom, items = [], notes } = req.body;
  if (!outletId || !items.length) {
    throw badRequest('outletId and at least one item are required');
  }

  let subtotal = 0;
  let taxAmount = 0;
  const orderNumber = `POS-${Date.now().toString().slice(-6)}`;

  const createdOrder = await db.transaction(async (trx) => {
    // 1. Calculate totals
    const preparedItems = [];
    for (const it of items) {
      const lineSubtotal = Number(it.unitPrice) * Number(it.quantity);
      const lineTax = lineSubtotal * ((it.taxRate ?? 7.5) / 100);
      subtotal += lineSubtotal;
      taxAmount += lineTax;
      preparedItems.push({
        menu_item_id: it.menuItemId || null,
        item_name: it.name,
        quantity: it.quantity,
        unit_price: it.unitPrice,
        total_price: lineSubtotal,
        special_instructions: it.specialInstructions || null,
        status: 'pending',
      });
    }

    const totalAmount = Number((subtotal + taxAmount).toFixed(2));

    const [orderId] = await trx('pos_orders').insert({
      outlet_id: outletId,
      stay_id: stayId || null,
      room_id: roomId || null,
      server_staff_id: req.staff?.id || null,
      order_number: orderNumber,
      order_type: orderType,
      table_or_room: tableOrRoom || 'Counter',
      status: 'sent_to_kitchen',
      subtotal: Number(subtotal.toFixed(2)),
      tax_amount: Number(taxAmount.toFixed(2)),
      total_amount: totalAmount,
      payment_status: 'unpaid',
      notes: notes || null,
    });

    for (const p of preparedItems) {
      await trx('pos_order_items').insert({ ...p, order_id: orderId });
    }

    return { id: orderId, orderNumber, totalAmount };
  });

  res.status(201).json({ success: true, data: createdOrder });
});

// GET /admin/pos/orders/:id
router.get('/orders/:id', async (req, res) => {
  const order = await db('pos_orders as o')
    .leftJoin('pos_outlets as out', 'out.id', 'o.outlet_id')
    .leftJoin('staff as st', 'st.id', 'o.server_staff_id')
    .where('o.id', req.params.id)
    .first('o.*', 'out.name as outlet_name', 'st.name as server_name');
  if (!order) throw notFound('Order');

  const items = await db('pos_order_items').where({ order_id: order.id });
  const payments = await db('pos_payments').where({ order_id: order.id });

  res.json({ success: true, data: { ...order, items, payments } });
});

// PATCH /admin/pos/orders/:id/status
router.patch('/orders/:id/status', async (req, res) => {
  const { status } = req.body;
  await db('pos_orders').where({ id: req.params.id }).update({ status, updated_at: new Date() });
  res.json({ success: true, message: `Order status updated to ${status}` });
});

// POST /admin/pos/orders/:id/pay
router.post('/orders/:id/pay', async (req, res) => {
  const { paymentMethod = 'card', amount, referenceCode } = req.body;
  const order = await db('pos_orders').where({ id: req.params.id }).first();
  if (!order) throw notFound('Order');

  const payAmount = Number(amount || order.total_amount);

  await db.transaction(async (trx) => {
    await trx('pos_payments').insert({
      order_id: order.id,
      payment_method: paymentMethod,
      amount: payAmount,
      reference_code: referenceCode || `TX-${Date.now().toString().slice(-6)}`,
      processed_by_staff_id: req.staff?.id || null,
      processed_at: new Date(),
    });
    await trx('pos_orders').where({ id: order.id }).update({
      payment_status: 'paid',
      status: 'completed',
      updated_at: new Date(),
    });
  });

  res.json({ success: true, message: 'Payment recorded successfully' });
});

// POST /admin/pos/orders/:id/charge-to-room
router.post('/orders/:id/charge-to-room', async (req, res) => {
  const { stayId } = req.body;
  const order = await db('pos_orders').where({ id: req.params.id }).first();
  if (!order) throw notFound('Order');

  const targetStayId = stayId || order.stay_id;
  if (!targetStayId) {
    throw badRequest('No active stay associated with this order to charge.');
  }

  const stay = await db('stays').where({ id: targetStayId, status: 'checked_in' }).first();
  if (!stay) {
    throw badRequest('Guest stay is not currently checked-in.');
  }

  // Find or create folio
  let folio = await db('folios').where({ stay_id: stay.id, status: 'open' }).first();
  if (!folio) {
    const [folioId] = await db('folios').insert({
      stay_id: stay.id,
      guest_id: stay.guest_id,
      folio_number: `FOL-${stay.reference || stay.id}`,
      status: 'open',
      currency: 'USD',
      balance: 0.00,
    });
    folio = await db('folios').where({ id: folioId }).first();
  }

  await db.transaction(async (trx) => {
    // 1. Post charge
    await trx('folio_charges').insert({
      folio_id: folio.id,
      charge_type: 'pos_fnb',
      description: `F&B Charge - Order #${order.order_number} (${order.table_or_room || 'Dining'})`,
      amount: Number(order.subtotal),
      tax_amount: Number(order.tax_amount),
      reference_id: String(order.id),
      posted_by_staff_id: req.staff?.id || null,
      created_at: new Date(),
    });

    // 2. Update folio balance
    const newBalance = Number(folio.balance) + Number(order.total_amount);
    await trx('folios').where({ id: folio.id }).update({ balance: newBalance, updated_at: new Date() });

    // 3. Mark POS order as posted
    await trx('pos_orders').where({ id: order.id }).update({
      stay_id: stay.id,
      payment_status: 'posted_to_room',
      status: 'completed',
      updated_at: new Date(),
    });

    // 4. Record POS payment record
    await trx('pos_payments').insert({
      order_id: order.id,
      payment_method: 'room_folio',
      amount: Number(order.total_amount),
      reference_code: `FOLIO-${folio.folio_number}`,
      processed_by_staff_id: req.staff?.id || null,
      processed_at: new Date(),
    });
  });

  res.json({ success: true, message: `Charged $${order.total_amount} to Room Folio ${folio.folio_number}` });
});

// GET /admin/pos/reports/daily-z
router.get('/reports/daily-z', async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const orders = await db('pos_orders')
    .where('created_at', '>=', today)
    .whereIn('payment_status', ['paid', 'posted_to_room']);

  const totalSales = orders.reduce((sum, o) => sum + Number(o.total_amount), 0);
  const totalTax = orders.reduce((sum, o) => sum + Number(o.tax_amount), 0);
  const totalOrders = orders.length;

  const payments = await db('pos_payments as p')
    .join('pos_orders as o', 'o.id', 'p.order_id')
    .where('p.processed_at', '>=', today)
    .groupBy('p.payment_method')
    .select('p.payment_method')
    .sum('p.amount as total');

  res.json({
    success: true,
    data: {
      date: today.toISOString().split('T')[0],
      totalOrders,
      totalSales: Number(totalSales.toFixed(2)),
      totalTax: Number(totalTax.toFixed(2)),
      paymentBreakdown: payments,
    },
  });
});

export default router;
