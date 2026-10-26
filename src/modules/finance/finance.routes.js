import { Router } from 'express';
import { db } from '../../config/db.js';
import { notFound, badRequest } from '../../core/errors.js';

const router = Router();

// GET /admin/finance/folios
router.get('/folios', async (req, res) => {
  const { status = 'open' } = req.query;
  const q = db('folios as f')
    .join('stays as s', 's.id', 'f.stay_id')
    .join('guests as g', 'g.id', 'f.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .select(
      'f.*',
      'g.first_name',
      'g.last_name',
      'g.email as guest_email',
      'r.number as room_number',
      's.reference as stay_reference',
      's.check_in_at',
      's.check_out_at',
      's.status as stay_status'
    )
    .orderBy('f.created_at', 'desc');

  if (status && status !== 'all') {
    q.where('f.status', status);
  }

  const folios = await q;
  res.json({ success: true, data: folios });
});

// GET /admin/finance/folios/:id
router.get('/folios/:id', async (req, res) => {
  const folio = await db('folios as f')
    .join('stays as s', 's.id', 'f.stay_id')
    .join('guests as g', 'g.id', 'f.guest_id')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .where('f.id', req.params.id)
    .first(
      'f.*',
      'g.first_name',
      'g.last_name',
      'g.email as guest_email',
      'g.phone as guest_phone',
      'r.number as room_number',
      's.reference as stay_reference',
      's.check_in_at',
      's.check_out_at'
    );
  if (!folio) throw notFound('Folio');

  const charges = await db('folio_charges as fc')
    .leftJoin('staff as st', 'st.id', 'fc.posted_by_staff_id')
    .where('fc.folio_id', folio.id)
    .select('fc.*', 'st.name as posted_by_name')
    .orderBy('fc.created_at', 'asc');

  const payments = await db('folio_payments as fp')
    .leftJoin('staff as st', 'st.id', 'fp.staff_id')
    .where('fp.folio_id', folio.id)
    .select('fp.*', 'st.name as staff_name')
    .orderBy('fp.settled_at', 'asc');

  const totalCharges = charges.reduce((sum, c) => sum + Number(c.amount) + Number(c.tax_amount), 0);
  const totalPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
  const currentBalance = Number((totalCharges - totalPaid).toFixed(2));

  res.json({
    success: true,
    data: {
      ...folio,
      totalCharges: Number(totalCharges.toFixed(2)),
      totalPaid: Number(totalPaid.toFixed(2)),
      balance: currentBalance,
      charges,
      payments,
    },
  });
});

// POST /admin/finance/folios/:id/charge
router.post('/folios/:id/charge', async (req, res) => {
  const { chargeType = 'incidental', description, amount, taxRate = 7.5 } = req.body;
  if (!description || !amount) throw badRequest('Description and amount are required');

  const folio = await db('folios').where({ id: req.params.id }).first();
  if (!folio) throw notFound('Folio');

  const amt = Number(amount);
  const tax = Number((amt * (taxRate / 100)).toFixed(2));
  const totalCharge = amt + tax;

  await db.transaction(async (trx) => {
    await trx('folio_charges').insert({
      folio_id: folio.id,
      charge_type: chargeType,
      description,
      amount: amt,
      tax_amount: tax,
      posted_by_staff_id: req.staff?.id || null,
      created_at: new Date(),
    });

    await trx('folios').where({ id: folio.id }).increment('balance', totalCharge);
  });

  res.json({ success: true, message: `Charge of $${totalCharge.toFixed(2)} posted to Folio ${folio.folio_number}` });
});

// POST /admin/finance/folios/:id/settle
router.post('/folios/:id/settle', async (req, res) => {
  const { paymentMethod = 'credit_card', cardLastFour, authCode, amount } = req.body;
  const folio = await db('folios').where({ id: req.params.id }).first();
  if (!folio) throw notFound('Folio');

  const payAmount = Number(amount ?? folio.balance);

  await db.transaction(async (trx) => {
    await trx('folio_payments').insert({
      folio_id: folio.id,
      payment_method: paymentMethod,
      amount: payAmount,
      card_last_four: cardLastFour || '4242',
      auth_code: authCode || `AUTH-${Date.now().toString().slice(-6)}`,
      transaction_reference: `SETTLE-${Date.now().toString().slice(-6)}`,
      settled_at: new Date(),
      staff_id: req.staff?.id || null,
    });

    const newBalance = Math.max(0, Number(folio.balance) - payAmount);
    await trx('folios').where({ id: folio.id }).update({
      balance: newBalance,
      status: newBalance <= 0 ? 'settled' : 'open',
      updated_at: new Date(),
    });
  });

  res.json({ success: true, message: `Folio ${folio.folio_number} settled with payment of $${payAmount.toFixed(2)}` });
});

// GET /admin/finance/reports/manager-daily
router.get('/reports/manager-daily', async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const charges = await db('folio_charges').where('created_at', '>=', today);
  const roomsTotal = await db('rooms').count({ n: '*' }).first();
  const occupiedTotal = await db('stays').where({ status: 'checked_in' }).count({ n: '*' }).first();

  const totalRoomRev = charges.filter((c) => c.charge_type === 'room_rate').reduce((s, c) => s + Number(c.amount), 0);
  const totalFnbRev = charges.filter((c) => c.charge_type === 'pos_fnb' || c.charge_type === 'minibar').reduce((s, c) => s + Number(c.amount), 0);
  const totalTaxes = charges.reduce((s, c) => s + Number(c.tax_amount), 0);
  const totalRev = charges.reduce((s, c) => s + Number(c.amount) + Number(c.tax_amount), 0);

  const totalRooms = Number(roomsTotal.n) || 24;
  const occupied = Number(occupiedTotal.n) || 12;
  const occupancyRate = Number(((occupied / totalRooms) * 100).toFixed(1));
  const adr = occupied > 0 ? Number((totalRoomRev / occupied).toFixed(2)) : 0;
  const revpar = Number(((totalRoomRev / totalRooms)).toFixed(2));

  res.json({
    success: true,
    data: {
      date: today.toISOString().split('T')[0],
      totalRevenue: Number(totalRev.toFixed(2)),
      roomRevenue: Number(totalRoomRev.toFixed(2)),
      fnbRevenue: Number(totalFnbRev.toFixed(2)),
      taxesCollected: Number(totalTaxes.toFixed(2)),
      occupancyRate,
      adr,
      revpar,
      totalRooms,
      occupiedRooms: occupied,
    },
  });
});

export default router;
