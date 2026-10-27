import { db } from '../config/db.js';

/** Tables: vendors, purchase_orders, purchase_order_items. */

/* ---- vendors ------------------------------------------------------------------- */

export function listActiveVendors() {
  return db('vendors').where({ is_active: true }).orderBy('company_name');
}

export async function createVendor(fields) {
  const [id] = await db('vendors').insert(fields);
  return id;
}

/* ---- purchase orders ------------------------------------------------------------ */

/** Purchase orders newest first with vendor and creator names. */
export function listOrders({ status }) {
  const q = db('purchase_orders as po')
    .leftJoin('vendors as v', 'v.id', 'po.vendor_id')
    .leftJoin('staff as st', 'st.id', 'po.created_by_staff_id')
    .select('po.*', 'v.company_name as vendor_name', 'st.name as creator_name')
    .orderBy('po.created_at', 'desc');
  if (status) q.where('po.status', status);
  return q;
}

export function findOrderWithVendor(id) {
  return db('purchase_orders as po').leftJoin('vendors as v', 'v.id', 'po.vendor_id').where('po.id', id).first('po.*', 'v.company_name as vendor_name', 'v.email as vendor_email', 'v.phone as vendor_phone');
}

export function findOrder(id) {
  return db('purchase_orders').where({ id }).first();
}

export async function createOrder(fields, trx = db) {
  const [id] = await trx('purchase_orders').insert(fields);
  return id;
}

export function updateOrder(id, fields, trx = db) {
  return trx('purchase_orders').where({ id }).update(fields);
}

/* ---- purchase order lines --------------------------------------------------------- */

export function addOrderItem(fields, trx = db) {
  return trx('purchase_order_items').insert(fields);
}

/** Lines of a purchase order with item name, SKU and unit. */
export function orderItems(poId) {
  return db('purchase_order_items as poi')
    .leftJoin('inventory_items as i', 'i.id', 'poi.item_id')
    .where('poi.po_id', poId)
    .select('poi.*', 'i.name as item_name', 'i.sku as item_sku', 'i.unit as item_unit');
}

export function findOrderItem(poId, itemId, trx = db) {
  return trx('purchase_order_items').where({ po_id: poId, item_id: itemId }).first();
}

export function updateOrderItem(id, fields, trx = db) {
  return trx('purchase_order_items').where({ id }).update(fields);
}
