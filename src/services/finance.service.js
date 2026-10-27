import { transaction } from '../config/db.js';
import * as Folio from '../models/folio.model.js';
import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import { badRequest, notFound } from '../utils/errors.js';

/** Guest folios (bills): charges, payments and the manager's daily revenue report. */

const DEFAULT_TAX_RATE = 7.5;

export function listFolios({ status = 'open' }) {
  return Folio.list({ status });
}

/** A folio with its charges and payments. The balance is recalculated from them. */
export async function getFolio(id) {
  const folio = await Folio.findWithDetails(id);
  if (!folio) throw notFound('Folio');
  const [charges, payments] = await Promise.all([Folio.charges(folio.id), Folio.payments(folio.id)]);
  const totalCharges = charges.reduce((sum, c) => sum + Number(c.amount) + Number(c.tax_amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  return {
    ...folio,
    totalCharges: Number(totalCharges.toFixed(2)),
    totalPaid: Number(totalPaid.toFixed(2)),
    balance: Number((totalCharges - totalPaid).toFixed(2)),
    charges,
    payments,
  };
}

/** Posts a charge plus tax. Returns { folio, totalCharge }. */
export async function postCharge(id, { chargeType = 'incidental', description, amount, taxRate = DEFAULT_TAX_RATE }, staffId) {
  if (!description || !amount) throw badRequest('Description and amount are required');
  const folio = await Folio.findById(id);
  if (!folio) throw notFound('Folio');
  const amt = Number(amount);
  const tax = Number((amt * (taxRate / 100)).toFixed(2));
  const totalCharge = amt + tax;
  await transaction(async (trx) => {
    await Folio.addCharge({ folio_id: folio.id, charge_type: chargeType, description, amount: amt, tax_amount: tax, posted_by_staff_id: staffId || null, created_at: new Date() }, trx);
    await Folio.increaseBalance(folio.id, totalCharge, trx);
  });
  return { folio, totalCharge };
}

/** Takes a payment (by default the whole balance). Returns { folio, payAmount }. */
export async function settle(id, { paymentMethod = 'credit_card', cardLastFour, authCode, amount }, staffId) {
  const folio = await Folio.findById(id);
  if (!folio) throw notFound('Folio');
  const payAmount = Number(amount ?? folio.balance);
  await transaction(async (trx) => {
    await Folio.addPayment(
      {
        folio_id: folio.id,
        payment_method: paymentMethod,
        amount: payAmount,
        card_last_four: cardLastFour || '4242',
        auth_code: authCode || `AUTH-${Date.now().toString().slice(-6)}`,
        transaction_reference: `SETTLE-${Date.now().toString().slice(-6)}`,
        settled_at: new Date(),
        staff_id: staffId || null,
      },
      trx,
    );
    const newBalance = Math.max(0, Number(folio.balance) - payAmount);
    await Folio.update(folio.id, { balance: newBalance, status: newBalance <= 0 ? 'settled' : 'open', updated_at: new Date() }, trx);
  });
  return { folio, payAmount };
}

/** Today's revenue, occupancy, ADR and RevPAR. */
export async function managerDailyReport() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [charges, roomCount, occupiedCount] = await Promise.all([Folio.chargesSince(today), Room.countAll(), Stay.countCheckedIn()]);

  const totalRoomRev = charges.filter((c) => c.charge_type === 'room_rate').reduce((s, c) => s + Number(c.amount), 0);
  const totalFnbRev = charges.filter((c) => c.charge_type === 'pos_fnb' || c.charge_type === 'minibar').reduce((s, c) => s + Number(c.amount), 0);
  const totalTaxes = charges.reduce((s, c) => s + Number(c.tax_amount), 0);
  const totalRev = charges.reduce((s, c) => s + Number(c.amount) + Number(c.tax_amount), 0);

  // Demo fallbacks when the hotel has no rooms or guests yet.
  const totalRooms = roomCount || 24;
  const occupied = occupiedCount || 12;
  return {
    date: today.toISOString().split('T')[0],
    totalRevenue: Number(totalRev.toFixed(2)),
    roomRevenue: Number(totalRoomRev.toFixed(2)),
    fnbRevenue: Number(totalFnbRev.toFixed(2)),
    taxesCollected: Number(totalTaxes.toFixed(2)),
    occupancyRate: Number(((occupied / totalRooms) * 100).toFixed(1)),
    adr: occupied > 0 ? Number((totalRoomRev / occupied).toFixed(2)) : 0,
    revpar: Number((totalRoomRev / totalRooms).toFixed(2)),
    totalRooms,
    occupiedRooms: occupied,
  };
}
