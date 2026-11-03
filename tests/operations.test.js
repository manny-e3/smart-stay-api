/**
 * Characterization tests for POS, inventory, procurement, finance, AI, room devices and the
 * guest account / booking / voice endpoints. They pin the current behaviour so refactors
 * can't change it unnoticed.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, as, seedHotel, checkIn, api } from './helpers.js';
import { db } from '../src/config/db.js';

let hotel;
beforeEach(async () => {
  await resetDb();
  hotel = await seedHotel({ guestDevices: true });
});
afterAll(() => db.destroy());

const inHours = (h) => new Date(Date.now() + h * 3_600_000).toISOString();

async function seedPos() {
  const [outletId] = await db('pos_outlets').insert({ name: 'Palm Terrace', code: 'PALM' });
  const [categoryId] = await db('pos_categories').insert({ outlet_id: outletId, name: 'Mains', display_order: 1 });
  await db('pos_menu_items').insert({ outlet_id: outletId, category_id: categoryId, sku: 'JOLLOF', name: 'Jollof Rice', price: 20, tax_rate: 7.5 });
  return { outletId, categoryId };
}

async function openFolio(stayId, guestId) {
  const [id] = await db('folios').insert({ stay_id: stayId, guest_id: guestId, folio_number: `FOL-T-${stayId}`, status: 'open', currency: 'USD', balance: 0 });
  return id;
}

describe('POS', () => {
  it('lists outlets, categories and menu', async () => {
    const { outletId } = await seedPos();
    const staff = await as('service');
    expect((await staff.get('/admin/pos/outlets')).body.data.map((o) => o.code)).toEqual(['PALM']);
    expect((await staff.get(`/admin/pos/categories?outletId=${outletId}`)).body.data).toHaveLength(1);
    const menu = (await staff.get('/admin/pos/menu')).body.data;
    expect(menu[0]).toMatchObject({ name: 'Jollof Rice', category_name: 'Mains', outlet_name: 'Palm Terrace' });
  });

  it('creates an order with tax, pays it, and reports it in the daily Z', async () => {
    const { outletId } = await seedPos();
    const staff = await as('manager');
    expect((await staff.post('/admin/pos/orders').send({ outletId, items: [] })).status).toBe(400);
    const created = await staff.post('/admin/pos/orders').send({ outletId, items: [{ name: 'Jollof Rice', unitPrice: 20, quantity: 2 }] });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ totalAmount: 43 });

    const id = created.body.data.id;
    const detail = (await staff.get(`/admin/pos/orders/${id}`)).body.data;
    expect(detail).toMatchObject({ status: 'sent_to_kitchen', payment_status: 'unpaid', items: [{ item_name: 'Jollof Rice', quantity: 2 }] });
    expect((await staff.get('/admin/pos/orders/99999')).status).toBe(404);

    expect((await staff.patch(`/admin/pos/orders/${id}/status`).send({ status: 'served' })).body.message).toMatch(/served/);
    expect((await staff.get('/admin/pos/orders?status=served')).body.data).toHaveLength(1);

    await staff.post(`/admin/pos/orders/${id}/pay`).send({ paymentMethod: 'cash' });
    const paid = (await staff.get(`/admin/pos/orders/${id}`)).body.data;
    expect(paid).toMatchObject({ payment_status: 'paid', status: 'completed', payments: [{ payment_method: 'cash' }] });

    const z = (await staff.get('/admin/pos/reports/daily-z')).body.data;
    expect(z).toMatchObject({ totalOrders: 1, totalSales: 43, totalTax: 3 });
    expect(z.paymentBreakdown[0]).toMatchObject({ payment_method: 'cash' });
  });

  it('charges an order to a checked-in guest folio', async () => {
    const { outletId } = await seedPos();
    const { stayId } = await checkIn(hotel.rooms[0].id);
    const staff = await as('manager');
    const order = (await staff.post('/admin/pos/orders').send({ outletId, items: [{ name: 'Water', unitPrice: 10, quantity: 1 }] })).body.data;
    expect((await staff.post(`/admin/pos/orders/${order.id}/charge-to-room`).send({})).status).toBe(400);
    const res = await staff.post(`/admin/pos/orders/${order.id}/charge-to-room`).send({ stayId });
    expect(res.status).toBe(200);
    const folio = await db('folios').where({ stay_id: stayId }).first();
    expect(Number(folio.balance)).toBe(10.75);
    expect((await db('pos_orders').where({ id: order.id }).first()).payment_status).toBe('posted_to_room');
  });
});

describe('inventory and procurement', () => {
  it('creates items, adjusts stock and restocks a minibar with a folio charge', async () => {
    const staff = await as('manager');
    expect((await staff.post('/admin/inventory/items').send({ name: 'No SKU' })).status).toBe(400);
    const item = (await staff.post('/admin/inventory/items').send({ sku: 'COKE', name: 'Coke', currentStock: 10, unitCost: 2, minReorderLevel: 9 })).body.data;
    expect(item).toMatchObject({ sku: 'COKE' });

    await staff.post('/admin/inventory/transactions').send({ itemId: item.id, type: 'wastage', quantity: 2 });
    expect((await db('inventory_items').where({ id: item.id }).first()).current_stock).toBe(8);
    expect((await staff.get('/admin/inventory/items?lowStock=true')).body.data.map((i) => i.sku)).toEqual(['COKE']);
    expect((await staff.post('/admin/inventory/transactions').send({ itemId: 999, type: 'wastage', quantity: 1 })).status).toBe(404);

    const { stayId, guestId } = await checkIn(hotel.rooms[0].id);
    const folioId = await openFolio(stayId, guestId);
    const restock = await staff.post(`/admin/inventory/rooms/${hotel.rooms[0].id}/minibar-restock`).send({ items: [{ itemId: item.id, consumedQty: 2 }] });
    expect(restock.body.message).toMatch(/Room 101/);
    expect((await db('inventory_items').where({ id: item.id }).first()).current_stock).toBe(6);
    expect(Number((await db('folios').where({ id: folioId }).first()).balance)).toBe(10.75);
    expect((await staff.get('/admin/inventory/categories')).status).toBe(200);
  });

  it('creates vendors and purchase orders and receives goods into stock', async () => {
    const staff = await as('manager');
    const [itemId] = await db('inventory_items').insert({ sku: 'SOAP', name: 'Soap', current_stock: 1 });
    expect((await staff.post('/admin/procurement/vendors').send({})).status).toBe(400);
    const vendor = (await staff.post('/admin/procurement/vendors').send({ companyName: 'Lagos Supplies' })).body.data;
    expect((await staff.get('/admin/procurement/vendors')).body.data[0]).toMatchObject({ company_name: 'Lagos Supplies', payment_terms: 'Net 30' });

    const po = (await staff.post('/admin/procurement/orders').send({ vendorId: vendor.id, items: [{ itemId, orderedQuantity: 5, unitPrice: 3 }] })).body.data;
    expect(po).toMatchObject({ totalAmount: 15 });
    expect((await staff.get(`/admin/procurement/orders/${po.id}`)).body.data).toMatchObject({ vendor_name: 'Lagos Supplies', items: [{ item_sku: 'SOAP', ordered_quantity: 5 }] });
    expect((await staff.get('/admin/procurement/orders?status=ordered')).body.data).toHaveLength(1);

    await staff.post(`/admin/procurement/orders/${po.id}/receive`).send({ receivedItems: [{ itemId, qtyReceived: 5 }] });
    expect((await db('inventory_items').where({ id: itemId }).first()).current_stock).toBe(6);
    expect((await db('purchase_orders').where({ id: po.id }).first()).status).toBe('received');
    expect((await staff.get('/admin/procurement/orders/999')).status).toBe(404);
  });
});

describe('finance', () => {
  it('lists folios, posts charges, settles and reports', async () => {
    const { stayId, guestId } = await checkIn(hotel.rooms[0].id);
    const folioId = await openFolio(stayId, guestId);
    const staff = await as('manager');
    expect((await staff.get('/admin/finance/folios')).body.data[0]).toMatchObject({ id: folioId, room_number: '101' });
    expect((await staff.post(`/admin/finance/folios/${folioId}/charge`).send({ amount: 100 })).status).toBe(400);
    await staff.post(`/admin/finance/folios/${folioId}/charge`).send({ chargeType: 'room_rate', description: 'Night 1', amount: 100 });
    const detail = (await staff.get(`/admin/finance/folios/${folioId}`)).body.data;
    expect(detail).toMatchObject({ totalCharges: 107.5, totalPaid: 0, balance: 107.5, charges: [{ description: 'Night 1' }] });

    await staff.post(`/admin/finance/folios/${folioId}/settle`).send({ amount: 107.5 });
    expect((await db('folios').where({ id: folioId }).first()).status).toBe('settled');
    expect((await staff.get('/admin/finance/folios?status=all')).body.data).toHaveLength(1);

    const report = (await staff.get('/admin/finance/reports/manager-daily')).body.data;
    expect(report).toMatchObject({ roomRevenue: 100, totalRevenue: 107.5, occupiedRooms: 1, totalRooms: 6 });
    expect((await staff.get('/admin/finance/folios/999')).status).toBe(404);
  });
});

describe('AI', () => {
  it('answers copilot tasks and guest chat, creating requests when asked', async () => {
    const { stayId, guestId } = await checkIn(hotel.rooms[0].id, 'Ada');
    const staff = await as('manager');
    const brief = (await staff.post('/admin/ai/copilot').send({ task: 'guest_dossier_brief', context: { guestId, stayId } })).body.data.response;
    expect(brief).toContain('Ada');
    expect((await staff.post('/admin/ai/copilot').send({ task: 'shift_handover_summary' })).body.data.response).toMatch(/1 active guest suites/);
    expect((await staff.post('/admin/ai/copilot').send({ task: 'draft_feedback_reply', context: { guestName: 'Ada', rating: 5 } })).body.data.response).toMatch(/Dear Ada/);

    expect((await api().post('/guest/ai/guest-chat').send({})).status).toBe(400);
    const chat = (await api().post('/guest/ai/guest-chat').send({ message: 'More towels please', roomId: hotel.rooms[0].id, stayId })).body.data;
    expect(chat.actionTaken).toBe('dispatched_housekeeping_ticket');
    expect(await db('requests').where({ room_id: hotel.rooms[0].id, category: 'housekeeping' }).first()).toBeTruthy();
  });
});

describe('room devices', () => {
  it('lists, adds, edits and removes devices in a room', async () => {
    const admin = await as('admin');
    const roomId = hotel.rooms[0].id;
    const before = (await admin.get(`/admin/rooms/${roomId}/devices`)).body.data;
    expect(before.length).toBeGreaterThan(0);
    const added = await admin.post(`/admin/rooms/${roomId}/devices`).send({ type: 'light', name: 'Desk lamp' });
    expect(added.status).toBe(201);
    const deviceId = added.body.data.id;
    expect((await admin.patch(`/admin/rooms/${roomId}/devices/${deviceId}`).send({ name: 'Reading lamp' })).status).toBe(200);
    expect((await db('devices').where({ id: deviceId }).first()).name).toBe('Reading lamp');
    expect((await admin.delete(`/admin/rooms/${roomId}/devices/${deviceId}`)).status).toBe(200);
  });

  it('creates a room with a room type and price', async () => {
    const admin = await as('admin');
    const res = await admin.post('/admin/rooms').send({ number: '901', floor: 9, roomType: 'Suite', basePrice: 300 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ number: '901' });
  });
});

describe('guest accounts, bookings and voice', () => {
  it('registers, logs in with a password and resets it', async () => {
    const reg = await api().post('/guest/register').send({ firstName: 'Kemi', lastName: 'Ade', email: 'Kemi@Example.com', password: 'secret12' });
    expect(reg.status).toBe(201);
    expect(reg.body.data.guest).toMatchObject({ email: 'kemi@example.com' });
    expect((await api().post('/guest/register').send({ firstName: 'K', lastName: 'A', email: 'kemi@example.com', password: 'secret12' })).status).toBe(409);
    expect((await api().post('/guest/login').send({ email: 'kemi@example.com', password: 'secret12' })).status).toBe(201);
    expect((await api().post('/guest/login').send({ email: 'kemi@example.com', password: 'wrong' })).status).toBe(401);

    expect((await api().post('/guest/forgot-password').send({ email: 'kemi@example.com' })).status).toBe(200);
    const { reset_token: code } = await db('guests').where({ email: 'kemi@example.com' }).first();
    expect((await api().post('/guest/reset-password').send({ email: 'kemi@example.com', code: '000000', newPassword: 'newpass12' })).status).toBe(400);
    expect((await api().post('/guest/reset-password').send({ email: 'kemi@example.com', code, newPassword: 'newpass12' })).status).toBe(200);
    expect((await api().post('/guest/login').send({ email: 'kemi@example.com', password: 'newpass12' })).status).toBe(201);
  });

  it('shows the catalog and books with or without instant access', async () => {
    const catalog = (await api().get('/guest/rooms/catalog')).body.data;
    expect(catalog.catalog.length).toBeGreaterThan(0);
    expect(catalog).toMatchObject({ currency: 'USD' });

    const guest = { firstName: 'Musa', lastName: 'Bello', email: 'musa@example.com' };
    const later = await api().post('/guest/bookings').send({ roomType: 'Standard', arrival: inHours(48), departure: inHours(96), guest, paymentMethod: 'pay_at_hotel' });
    expect(later.status).toBe(201);
    expect(later.body.data).toMatchObject({ status: 'reserved', accessGranted: false, token: null });

    const now = await api().post('/guest/bookings').send({ roomType: 'Standard', arrival: inHours(-1), departure: inHours(24), guest, paymentMethod: 'credit_card' });
    expect(now.status).toBe(201);
    expect(now.body.data).toMatchObject({ status: 'checked_in', accessGranted: true });
    const token = now.body.data.token;
    const auth = (r) => r.set('Authorization', `Bearer ${token}`);
    expect((await auth(api().get('/guest/bookings/my'))).body.data.length).toBeGreaterThanOrEqual(1);
    expect((await auth(api().get('/guest/history'))).body.data.length).toBeGreaterThanOrEqual(1);

    const voice = (await auth(api().post('/guest/assistant/command')).send({ speechText: 'Hey Google, turn on the lights' })).body.data;
    expect(voice.action).toBe('lights_on');
    const alias = (await auth(api().post('/guest/voice-command')).send({ speechText: 'set temperature to 22' })).body.data;
    expect(alias).toMatchObject({ action: 'climate_setpoint', executedDetails: { setpoint: 22 } });
  });

  it('links a booking to a signed-in guest by booking code', async () => {
    await api().post('/guest/register').send({ firstName: 'Ife', lastName: 'Obi', email: 'ife@example.com', password: 'secret12' });
    const token = (await api().post('/guest/login').send({ email: 'ife@example.com', password: 'secret12' })).body.data.token;
    const fd = await as('front_desk');
    const stay = (await fd.post('/admin/stays').send({ guest: { firstName: 'Ife', lastName: 'Obi' }, roomId: hotel.rooms[2].id, departure: inHours(24), checkInNow: true })).body.data;
    const res = await api().post('/guest/link-booking').set('Authorization', `Bearer ${token}`).send({ bookingCode: stay.accessCode });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ roomNumber: '103' });
  });
});
