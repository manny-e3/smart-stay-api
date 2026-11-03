import { transaction } from '../config/db.js';
import * as Inventory from '../models/inventory.model.js';
import * as Folio from '../models/folio.model.js';
import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import { badRequest, notFound } from '../utils/errors.js';

/** Stock: items, stock movements and minibar restocking (charged to the guest's folio). */

const STOCK_OUT = ['room_refill', 'minibar_refill', 'wastage'];
const MINIBAR_MARKUP = 2.5;
const MINIBAR_TAX = 0.075;

export const listCategories = () => Inventory.listCategories();

export function listItems({ categoryId, lowStock }) {
  return Inventory.listItems({ categoryId, lowStock: lowStock === 'true' });
}

export async function createItem({ categoryId, sku, name, unit = 'pcs', parLevel = 20, minReorderLevel = 5, currentStock = 0, unitCost = 0.0, location }) {
  if (!sku || !name) throw badRequest('SKU and Name are required');
  const id = await Inventory.createItem({
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
  return { id, sku, name };
}

/** Records a stock movement. Returns the new stock level as shown in the message. */
export async function recordTransaction({ itemId, type, quantity, unitCost, roomId, notes }, staffId) {
  if (!itemId || !type || quantity === undefined) throw badRequest('itemId, type, and quantity required');
  const item = await Inventory.findItem(itemId);
  if (!item) throw notFound('Inventory Item');

  const qty = Number(quantity);
  const cost = Number(unitCost ?? item.unit_cost);
  const totalValue = Number((cost * Math.abs(qty)).toFixed(2));
  let stockDelta = qty;
  if (STOCK_OUT.includes(type)) stockDelta = -Math.abs(qty);
  else if (type === 'purchase_intake') stockDelta = Math.abs(qty);

  await transaction(async (trx) => {
    await Inventory.addTransaction(
      { item_id: item.id, type, quantity: stockDelta, unit_cost: cost, total_value: totalValue, room_id: roomId || null, staff_id: staffId || null, notes: notes || null, created_at: new Date() },
      trx,
    );
    await Inventory.updateItem(item.id, { current_stock: Math.max(0, Number(item.current_stock) + stockDelta), updated_at: new Date() }, trx);
  });
  return item.current_stock + stockDelta;
}

/**
 * Takes consumed minibar items out of stock and, when a guest is checked in with an open folio,
 * charges them at retail price. items: [{ itemId, consumedQty, chargeGuest }]
 */
export async function restockMinibar(roomId, { items = [] }, staffId) {
  const room = await Room.findById(roomId);
  if (!room) throw notFound('Room');
  const stay = await Stay.findCheckedInForRoom(room.id);

  await transaction(async (trx) => {
    const folio = stay ? await Folio.findOpenForStay(stay.id, trx) : null;
    for (const line of items) {
      const invItem = await Inventory.findItem(line.itemId, trx);
      if (!invItem) continue;
      const consumed = Number(line.consumedQty || 1);
      await Inventory.addTransaction(
        {
          item_id: invItem.id,
          type: 'minibar_refill',
          quantity: -consumed,
          unit_cost: invItem.unit_cost,
          total_value: Number((invItem.unit_cost * consumed).toFixed(2)),
          room_id: room.id,
          staff_id: staffId || null,
          notes: `Replenished after consumption in Room ${room.number}`,
          created_at: new Date(),
        },
        trx,
      );
      await Inventory.updateItem(invItem.id, { current_stock: Math.max(0, invItem.current_stock - consumed), updated_at: new Date() }, trx);

      if (folio && line.chargeGuest !== false) {
        const retailPrice = Number((invItem.unit_cost * MINIBAR_MARKUP).toFixed(2));
        const lineTotal = retailPrice * consumed;
        const tax = Number((lineTotal * MINIBAR_TAX).toFixed(2));
        await Folio.addCharge(
          { folio_id: folio.id, charge_type: 'minibar', description: `Minibar: ${invItem.name} (x${consumed})`, amount: lineTotal, tax_amount: tax, posted_by_staff_id: staffId || null, created_at: new Date() },
          trx,
        );
        await Folio.increaseBalance(folio.id, lineTotal + tax, trx);
      }
    }
  });
  return room;
}
