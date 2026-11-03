import { db } from '../config/db.js';

/** Tables: pos_outlets, pos_categories, pos_menu_items, pos_orders, pos_order_items, pos_payments. */

/* ---- outlets, categories, menu ----------------------------------------------------- */

export function listActiveOutlets() {
  return db('pos_outlets').where({ is_active: true }).orderBy('name');
}

export function listActiveCategories({ outletId }) {
  const q = db('pos_categories').where({ is_active: true }).orderBy('display_order');
  if (outletId) q.where({ outlet_id: outletId });
  return q;
}

/** Available menu items with category and outlet names. */
export function listAvailableMenuItems({ outletId, categoryId }) {
  const q = db('pos_menu_items as m')
    .leftJoin('pos_categories as c', 'c.id', 'm.category_id')
    .leftJoin('pos_outlets as o', 'o.id', 'm.outlet_id')
    .select('m.*', 'c.name as category_name', 'o.name as outlet_name')
    .where('m.is_available', true);
  if (outletId) q.where('m.outlet_id', outletId);
  if (categoryId) q.where('m.category_id', categoryId);
  return q;
}

/* ---- orders -------------------------------------------------------------------------- */

const withOutletAndServer = () => db('pos_orders as o').leftJoin('pos_outlets as out', 'out.id', 'o.outlet_id').leftJoin('staff as st', 'st.id', 'o.server_staff_id');

export function listOrders({ status, outletId, limit }) {
  const q = withOutletAndServer().select('o.*', 'out.name as outlet_name', 'st.name as server_name').orderBy('o.created_at', 'desc').limit(limit);
  if (status) q.where('o.status', status);
  if (outletId) q.where('o.outlet_id', outletId);
  return q;
}

export function findOrderWithDetails(id) {
  return withOutletAndServer().where('o.id', id).first('o.*', 'out.name as outlet_name', 'st.name as server_name');
}

export function findOrder(id) {
  return db('pos_orders').where({ id }).first();
}

export async function createOrder(fields, trx = db) {
  const [id] = await trx('pos_orders').insert(fields);
  return id;
}

export function updateOrder(id, fields, trx = db) {
  return trx('pos_orders').where({ id }).update(fields);
}

export function addOrderItem(fields, trx = db) {
  return trx('pos_order_items').insert(fields);
}

export function orderItems(orderId) {
  return db('pos_order_items').where({ order_id: orderId });
}

/** Paid or room-charged orders created since `since` (daily Z report). */
export function settledOrdersSince(since) {
  return db('pos_orders').where('created_at', '>=', since).whereIn('payment_status', ['paid', 'posted_to_room']);
}

/* ---- payments ------------------------------------------------------------------------ */

export function addPayment(fields, trx = db) {
  return trx('pos_payments').insert(fields);
}

export function orderPayments(orderId) {
  return db('pos_payments').where({ order_id: orderId });
}

/** Payment totals per method since `since`. */
export function paymentTotalsSince(since) {
  return db('pos_payments as p')
    .join('pos_orders as o', 'o.id', 'p.order_id')
    .where('p.processed_at', '>=', since)
    .groupBy('p.payment_method')
    .select('p.payment_method')
    .sum('p.amount as total');
}
