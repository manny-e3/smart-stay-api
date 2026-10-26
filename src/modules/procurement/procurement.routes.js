import { Router } from 'express';
import { db } from '../../config/db.js';
import { notFound, badRequest } from '../../core/errors.js';

const router = Router();

// GET /admin/procurement/vendors
router.get('/vendors', async (req, res) => {
  const vendors = await db('vendors').where({ is_active: true }).orderBy('company_name');
  res.json({ success: true, data: vendors });
});

// POST /admin/procurement/vendors
router.post('/vendors', async (req, res) => {
  const { companyName, contactName, email, phone, taxId, paymentTerms, address } = req.body;
  if (!companyName) throw badRequest('companyName is required');

  const [id] = await db('vendors').insert({
    company_name: companyName,
    contact_name: contactName || null,
    email: email || null,
    phone: phone || null,
    tax_id: taxId || null,
    payment_terms: paymentTerms || 'Net 30',
    address: address || null,
  });

  res.status(201).json({ success: true, data: { id, companyName } });
});

// GET /admin/procurement/orders
router.get('/orders', async (req, res) => {
  const { status } = req.query;
  const q = db('purchase_orders as po')
    .leftJoin('vendors as v', 'v.id', 'po.vendor_id')
    .leftJoin('staff as st', 'st.id', 'po.created_by_staff_id')
    .select('po.*', 'v.company_name as vendor_name', 'st.name as creator_name')
    .orderBy('po.created_at', 'desc');

  if (status) q.where('po.status', status);
  const orders = await q;
  res.json({ success: true, data: orders });
});

// POST /admin/procurement/orders
router.post('/orders', async (req, res) => {
  const { vendorId, expectedDeliveryDate, notes, items = [] } = req.body;
  if (!vendorId || !items.length) throw badRequest('vendorId and at least one item required');

  const poNumber = `PO-${Date.now().toString().slice(-6)}`;
  let totalAmount = 0;

  const createdPo = await db.transaction(async (trx) => {
    const preparedItems = [];
    for (const it of items) {
      const lineTotal = Number(it.unitPrice) * Number(it.orderedQuantity);
      totalAmount += lineTotal;
      preparedItems.push({
        item_id: it.itemId,
        ordered_quantity: it.orderedQuantity,
        received_quantity: 0,
        unit_price: it.unitPrice,
        total_price: lineTotal,
      });
    }

    const [poId] = await trx('purchase_orders').insert({
      po_number: poNumber,
      vendor_id: vendorId,
      status: 'ordered',
      total_amount: Number(totalAmount.toFixed(2)),
      expected_delivery_date: expectedDeliveryDate || null,
      created_by_staff_id: req.staff?.id || null,
      notes: notes || null,
    });

    for (const p of preparedItems) {
      await trx('purchase_order_items').insert({ ...p, po_id: poId });
    }

    return { id: poId, poNumber, totalAmount };
  });

  res.status(201).json({ success: true, data: createdPo });
});

// GET /admin/procurement/orders/:id
router.get('/orders/:id', async (req, res) => {
  const po = await db('purchase_orders as po')
    .leftJoin('vendors as v', 'v.id', 'po.vendor_id')
    .where('po.id', req.params.id)
    .first('po.*', 'v.company_name as vendor_name', 'v.email as vendor_email', 'v.phone as vendor_phone');
  if (!po) throw notFound('Purchase Order');

  const items = await db('purchase_order_items as poi')
    .leftJoin('inventory_items as i', 'i.id', 'poi.item_id')
    .where('poi.po_id', po.id)
    .select('poi.*', 'i.name as item_name', 'i.sku as item_sku', 'i.unit as item_unit');

  res.json({ success: true, data: { ...po, items } });
});

// POST /admin/procurement/orders/:id/receive
router.post('/orders/:id/receive', async (req, res) => {
  const { receivedItems = [] } = req.body; // [{ itemId, qtyReceived }]
  const po = await db('purchase_orders').where({ id: req.params.id }).first();
  if (!po) throw notFound('Purchase Order');

  await db.transaction(async (trx) => {
    for (const line of receivedItems) {
      const poItem = await trx('purchase_order_items').where({ po_id: po.id, item_id: line.itemId }).first();
      if (!poItem) continue;

      const qty = Number(line.qtyReceived || poItem.ordered_quantity);
      // 1. Update PO item received quantity
      await trx('purchase_order_items')
        .where({ id: poItem.id })
        .update({ received_quantity: Math.min(poItem.ordered_quantity, poItem.received_quantity + qty) });

      // 2. Increment physical stock
      await trx('inventory_items')
        .where({ id: line.itemId })
        .increment('current_stock', qty);

      // 3. Log stock intake transaction
      await trx('inventory_transactions').insert({
        item_id: line.itemId,
        type: 'purchase_intake',
        quantity: qty,
        unit_cost: poItem.unit_price,
        total_value: Number((poItem.unit_price * qty).toFixed(2)),
        staff_id: req.staff?.id || null,
        notes: `Received from ${po.po_number}`,
        created_at: new Date(),
      });
    }

    // Mark PO received
    await trx('purchase_orders').where({ id: po.id }).update({ status: 'received', updated_at: new Date() });
  });

  res.json({ success: true, message: `Goods received and added to inventory ledger.` });
});

export default router;
