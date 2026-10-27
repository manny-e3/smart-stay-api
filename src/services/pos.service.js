import { transaction } from '../config/db.js';
import * as Pos from '../models/pos.model.js';
import * as Folio from '../models/folio.model.js';
import * as Stay from '../models/stay.model.js';
import { badRequest, notFound } from '../utils/errors.js';

/** Point of sale: outlets, menu, orders, payments and charging an order to a guest's room bill. */

const DEFAULT_TAX_RATE = 7.5;

export const listOutlets = () => Pos.listActiveOutlets();
export const listCategories = (filters) => Pos.listActiveCategories(filters);
export const listMenu = (filters) => Pos.listAvailableMenuItems(filters);

export function listOrders({ status, outletId, limit = 50 }) {
  return Pos.listOrders({ status, outletId, limit: Number(limit) });
}

export async function getOrder(id) {
  const order = await Pos.findOrderWithDetails(id);
  if (!order) throw notFound('Order');
  const [items, payments] = await Promise.all([Pos.orderItems(order.id), Pos.orderPayments(order.id)]);
  return { ...order, items, payments };
}

/** Opens an order and sends it to the kitchen. Line prices come from the request. */
export async function createOrder({ outletId, stayId, roomId, orderType = 'dine_in', tableOrRoom, items = [], notes }, staffId) {
  if (!outletId || !items.length) throw badRequest('outletId and at least one item are required');

  let subtotal = 0;
  let taxAmount = 0;
  const orderNumber = `POS-${Date.now().toString().slice(-6)}`;
  const lines = items.map((it) => {
    const lineSubtotal = Number(it.unitPrice) * Number(it.quantity);
    subtotal += lineSubtotal;
    taxAmount += lineSubtotal * ((it.taxRate ?? DEFAULT_TAX_RATE) / 100);
    return {
      menu_item_id: it.menuItemId || null,
      item_name: it.name,
      quantity: it.quantity,
      unit_price: it.unitPrice,
      total_price: lineSubtotal,
      special_instructions: it.specialInstructions || null,
      status: 'pending',
    };
  });
  const totalAmount = Number((subtotal + taxAmount).toFixed(2));

  return transaction(async (trx) => {
    const orderId = await Pos.createOrder(
      {
        outlet_id: outletId,
        stay_id: stayId || null,
        room_id: roomId || null,
        server_staff_id: staffId || null,
        order_number: orderNumber,
        order_type: orderType,
        table_or_room: tableOrRoom || 'Counter',
        status: 'sent_to_kitchen',
        subtotal: Number(subtotal.toFixed(2)),
        tax_amount: Number(taxAmount.toFixed(2)),
        total_amount: totalAmount,
        payment_status: 'unpaid',
        notes: notes || null,
      },
      trx,
    );
    for (const line of lines) await Pos.addOrderItem({ ...line, order_id: orderId }, trx);
    return { id: orderId, orderNumber, totalAmount };
  });
}

export async function setOrderStatus(id, status) {
  await Pos.updateOrder(id, { status, updated_at: new Date() });
}

/** Records a payment and closes the order. */
export async function payOrder(id, { paymentMethod = 'card', amount, referenceCode }, staffId) {
  const order = await Pos.findOrder(id);
  if (!order) throw notFound('Order');
  const payAmount = Number(amount || order.total_amount);
  await transaction(async (trx) => {
    await Pos.addPayment(
      {
        order_id: order.id,
        payment_method: paymentMethod,
        amount: payAmount,
        reference_code: referenceCode || `TX-${Date.now().toString().slice(-6)}`,
        processed_by_staff_id: staffId || null,
        processed_at: new Date(),
      },
      trx,
    );
    await Pos.updateOrder(order.id, { payment_status: 'paid', status: 'completed', updated_at: new Date() }, trx);
  });
}

/** Posts the order to the checked-in guest's open folio (created if needed). Returns { order, folio }. */
export async function chargeToRoom(id, { stayId }, staffId) {
  const order = await Pos.findOrder(id);
  if (!order) throw notFound('Order');
  const targetStayId = stayId || order.stay_id;
  if (!targetStayId) throw badRequest('No active stay associated with this order to charge.');
  const stay = await Stay.findById(targetStayId);
  if (!stay || stay.status !== 'checked_in') throw badRequest('Guest stay is not currently checked-in.');

  let folio = await Folio.findOpenForStay(stay.id);
  if (!folio) {
    const folioId = await Folio.create({ stay_id: stay.id, guest_id: stay.guest_id, folio_number: `FOL-${stay.reference || stay.id}`, status: 'open', currency: 'USD', balance: 0.0 });
    folio = await Folio.findById(folioId);
  }

  await transaction(async (trx) => {
    await Folio.addCharge(
      {
        folio_id: folio.id,
        charge_type: 'pos_fnb',
        description: `F&B Charge - Order #${order.order_number} (${order.table_or_room || 'Dining'})`,
        amount: Number(order.subtotal),
        tax_amount: Number(order.tax_amount),
        reference_id: String(order.id),
        posted_by_staff_id: staffId || null,
        created_at: new Date(),
      },
      trx,
    );
    await Folio.update(folio.id, { balance: Number(folio.balance) + Number(order.total_amount), updated_at: new Date() }, trx);
    await Pos.updateOrder(order.id, { stay_id: stay.id, payment_status: 'posted_to_room', status: 'completed', updated_at: new Date() }, trx);
    await Pos.addPayment(
      {
        order_id: order.id,
        payment_method: 'room_folio',
        amount: Number(order.total_amount),
        reference_code: `FOLIO-${folio.folio_number}`,
        processed_by_staff_id: staffId || null,
        processed_at: new Date(),
      },
      trx,
    );
  });
  return { order, folio };
}

/** Today's sales: order count, totals and payments per method. */
export async function dailyZReport() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const orders = await Pos.settledOrdersSince(today);
  const payments = await Pos.paymentTotalsSince(today);
  return {
    date: today.toISOString().split('T')[0],
    totalOrders: orders.length,
    totalSales: Number(orders.reduce((sum, o) => sum + Number(o.total_amount), 0).toFixed(2)),
    totalTax: Number(orders.reduce((sum, o) => sum + Number(o.tax_amount), 0).toFixed(2)),
    paymentBreakdown: payments,
  };
}
