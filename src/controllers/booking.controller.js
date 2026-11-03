import * as bookingService from '../services/booking.service.js';

/** GET /guest/rooms/catalog */
export async function catalog(req, res) {
  res.json({ success: true, data: await bookingService.getCatalog() });
}

/** POST /guest/bookings */
export async function create(req, res) {
  const { data, message } = await bookingService.createBooking(req.valid.body, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ success: true, data, message });
}

/** GET /guest/bookings/my */
export async function myBookings(req, res) {
  res.json({ success: true, data: await bookingService.getMyBookings(req.guest.guestId) });
}
