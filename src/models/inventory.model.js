import { db } from '../config/db.js';

/** Tables: inventory_categories, inventory_items, inventory_transactions (stock movements). */

export function listCategories() {
  return db('inventory_categories').orderBy('name');
}

/** Items with category name. lowStock: only items at or below their reorder level. */
export function listItems({ categoryId, lowStock }) {
  const q = db('inventory_items as i').leftJoin('inventory_categories as c', 'c.id', 'i.category_id').select('i.*', 'c.name as category_name').orderBy('i.name');
  if (categoryId) q.where('i.category_id', categoryId);
  if (lowStock) q.whereRaw('i.current_stock <= i.min_reorder_level');
  return q;
}

export function findItem(id, trx = db) {
  return trx('inventory_items').where({ id }).first();
}

export async function createItem(fields) {
  const [id] = await db('inventory_items').insert(fields);
  return id;
}

export function updateItem(id, fields, trx = db) {
  return trx('inventory_items').where({ id }).update(fields);
}

export function increaseStock(id, quantity, trx = db) {
  return trx('inventory_items').where({ id }).increment('current_stock', quantity);
}

/** One stock movement (quantity is negative for stock going out). */
export function addTransaction(fields, trx = db) {
  return trx('inventory_transactions').insert(fields);
}
