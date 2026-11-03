import { transaction } from '../config/db.js';
import * as Procurement from '../models/procurement.model.js';
import * as Inventory from '../models/inventory.model.js';
import { badRequest, notFound } from '../utils/errors.js';

/** Vendors and purchase orders. Receiving goods adds them to inventory. */

export const listVendors = () => Procurement.listActiveVendors();

export async function createVendor({ companyName, contactName, email, phone, taxId, paymentTerms, address }) {
  if (!companyName) throw badRequest('companyName is required');
  const id = await Procurement.createVendor({
    company_name: companyName,
    contact_name: contactName || null,
    email: email || null,
    phone: phone || null,
    tax_id: taxId || null,
    payment_terms: paymentTerms || 'Net 30',
    address: address || null,
  });
  return { id, companyName };
}

export const listOrders = (filters) => Procurement.listOrders(filters);

export async function getOrder(id) {
  const po = await Procurement.findOrderWithVendor(id);
  if (!po) throw notFound('Purchase Order');
  return { ...po, items: await Procurement.orderItems(po.id) };
}

/** items: [{ itemId, orderedQuantity, unitPrice }] */
export async function createOrder({ vendorId, expectedDeliveryDate, notes, items = [] }, staffId) {
  if (!vendorId || !items.length) throw badRequest('vendorId and at least one item required');
  const poNumber = `PO-${Date.now().toString().slice(-6)}`;
  let totalAmount = 0;
  const lines = items.map((it) => {
    const lineTotal = Number(it.unitPrice) * Number(it.orderedQuantity);
    totalAmount += lineTotal;
    return { item_id: it.itemId, ordered_quantity: it.orderedQuantity, received_quantity: 0, unit_price: it.unitPrice, total_price: lineTotal };
  });

  return transaction(async (trx) => {
    const poId = await Procurement.createOrder(
      {
        po_number: poNumber,
        vendor_id: vendorId,
        status: 'ordered',
        total_amount: Number(totalAmount.toFixed(2)),
        expected_delivery_date: expectedDeliveryDate || null,
        created_by_staff_id: staffId || null,
        notes: notes || null,
      },
      trx,
    );
    for (const line of lines) await Procurement.addOrderItem({ ...line, po_id: poId }, trx);
    return { id: poId, poNumber, totalAmount };
  });
}

/** Books received goods into stock and marks the order received. receivedItems: [{ itemId, qtyReceived }] */
export async function receiveOrder(id, { receivedItems = [] }, staffId) {
  const po = await Procurement.findOrder(id);
  if (!po) throw notFound('Purchase Order');

  await transaction(async (trx) => {
    for (const line of receivedItems) {
      const poItem = await Procurement.findOrderItem(po.id, line.itemId, trx);
      if (!poItem) continue;
      const qty = Number(line.qtyReceived || poItem.ordered_quantity);
      await Procurement.updateOrderItem(poItem.id, { received_quantity: Math.min(poItem.ordered_quantity, poItem.received_quantity + qty) }, trx);
      await Inventory.increaseStock(line.itemId, qty, trx);
      await Inventory.addTransaction(
        {
          item_id: line.itemId,
          type: 'purchase_intake',
          quantity: qty,
          unit_cost: poItem.unit_price,
          total_value: Number((poItem.unit_price * qty).toFixed(2)),
          staff_id: staffId || null,
          notes: `Received from ${po.po_number}`,
          created_at: new Date(),
        },
        trx,
      );
    }
    await Procurement.updateOrder(po.id, { status: 'received', updated_at: new Date() }, trx);
  });
}
