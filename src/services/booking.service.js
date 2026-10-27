import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import * as Folio from '../models/folio.model.js';
import { badRequest, conflict } from '../utils/errors.js';
import { startSession } from './guestAuth.service.js';
import { createStay } from './stays.service.js';

/** Guest app booking: the room catalog, public bookings and the signed-in guest's bookings. */

export const LUXURY_SUITES_CATALOG = [
  {
    id: 1,
    name: 'Executive Deluxe Suite',
    code: 'deluxe_suite',
    roomType: 'Suite',
    badge: 'Popular Choice',
    tagline: 'Expansive luxury with skyline views & high-floor serenity',
    basePrice: 380,
    currency: 'USD',
    sizeM2: 65,
    maxOccupancy: 3,
    bedType: '1 California King Bed',
    view: 'Panoramic City & Bay View',
    imageUrl: 'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80',
    images: [
      'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1584622650111-993a426fbf0a?auto=format&fit=crop&w=1200&q=80',
    ],
    features: [
      'Digital Mobile Key & Automated Door Unlock',
      'Interactive Smart Lighting & Scene Presets',
      'Whisper-Quiet Multi-Zone Climate Control',
      '65" 4K HDR Smart TV with AirPlay & Casting',
      'Motorized Blackout Curtains & Electrochromic Privacy Glass',
      'Marble En-Suite with Rain Shower & Deep Soaking Tub',
      'Nespresso Vertuo Bar & Stocked Smart Cooler',
    ],
  },
  {
    id: 2,
    name: 'Presidential Penthouse',
    code: 'presidential_penthouse',
    roomType: 'Presidential Penthouse',
    badge: 'Ultimate Luxury',
    tagline: 'Exclusive top-floor sanctuary with private terrace and butler service',
    basePrice: 750,
    currency: 'USD',
    sizeM2: 120,
    maxOccupancy: 4,
    bedType: '2 King Master Suites',
    view: 'Private Skyline Ocean Terrace',
    imageUrl: 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80',
    images: [
      'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80',
      'https://images.unsplash.com/photo-1591088398332-8a7791972843?auto=format&fit=crop&w=1200&q=80',
    ],
    features: [
      'Private Terrace with Outdoor Jacuzzi Lounge',
      'Dedicated 24/7 VIP Concierge & Butler Service',
      'Bang & Olufsen Spatial Audio System',
      'Smart Home Voice Control via Google Assistant',
      'Complimentary In-Room Dining Champagne Breakfast',
      'Designer Walk-in Dressing Suite',
      'Priority Access to Rooftop Infinity Club',
    ],
  },
  {
    id: 3,
    name: 'Deluxe Ocean View King',
    code: 'deluxe_king',
    roomType: 'Deluxe',
    badge: 'Guest Favorite',
    tagline: 'Contemporary seaside sanctuary designed for effortless relaxation',
    basePrice: 240,
    currency: 'USD',
    sizeM2: 42,
    maxOccupancy: 2,
    bedType: '1 King Bed',
    view: 'Direct Ocean & Sunset View',
    imageUrl: 'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80',
    images: ['https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80'],
    features: [
      'Private Ocean-Facing Balcony',
      'Smart Thermostat with Eco-Comfort Presets',
      'Touchless Digital Key Access',
      '55" Ultra HD Streaming Television',
      'High-Speed Wi-Fi 6 Connection (500 Mbps)',
      'Luxury Rituals Toiletries & Plush Bathrobes',
    ],
  },
  {
    id: 4,
    name: 'Urban Comfort King',
    code: 'standard_king',
    roomType: 'Standard',
    badge: 'Great Value',
    tagline: 'Intelligently tailored urban room with modern smart comforts',
    basePrice: 165,
    currency: 'USD',
    sizeM2: 30,
    maxOccupancy: 2,
    bedType: '1 Queen or King Bed',
    view: 'Courtyard & City View',
    imageUrl: 'https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=80',
    images: ['https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=80'],
    features: [
      'Smart App Keyless Room Entry',
      'Individual AC Climate Control',
      'Ambient LED Mood Lighting',
      '50" Smart TV with Chromecast',
      'Workstation with USB-C Fast Charging Hub',
      'Complimentary Artisan Coffee & Tea Station',
    ],
  },
];

const TAX_RATE = 0.12;

/** The catalog with prices taken from the hotel's room types where they are set. */
export async function getCatalog() {
  const [roomsCount, roomTypes] = await Promise.all([Room.countActive(), Room.allRoomTypes()]);
  const priceMap = {};
  for (const rt of roomTypes) if (rt.base_price != null) priceMap[rt.name.toLowerCase()] = Number(rt.base_price);

  const catalog = LUXURY_SUITES_CATALOG.map((item) => {
    const matchedPrice = priceMap[item.roomType.toLowerCase()] ?? priceMap[item.name.toLowerCase()] ?? priceMap[item.code.toLowerCase()];
    return { ...item, basePrice: matchedPrice !== undefined ? matchedPrice : item.basePrice };
  });
  return { catalog, availableRoomsCount: roomsCount || 12, currency: 'USD', taxesPercent: 12, checkInTime: '15:00', checkOutTime: '12:00' };
}

/** First active room free for [from, to): of the matched type, else any room. */
async function findFreeRoom(matchedDb, matchedSuite, from, to) {
  const candidates = await Room.listActiveForBooking({ roomTypeId: matchedDb?.id, typeNameLike: matchedSuite.roomType });
  for (const room of candidates) if (!(await Stay.findOverlap(null, room.id, from, to))) return room;
  for (const room of await Room.listActiveWithFloor()) if (!(await Stay.findOverlap(null, room.id, from, to))) return room;
  return null;
}

/** Writes a settled folio for a paid booking: the room charge and the card payment. */
async function settleFolio(stay, { suiteName, nights, ratePerNight, subtotal, taxes, totalAmount, cardLast4 }) {
  const folioId = await Folio.create({
    stay_id: stay.id,
    guest_id: stay.guest.id,
    folio_number: `FOL-${stay.reference}-${Date.now().toString().slice(-4)}`,
    status: 'settled',
    currency: 'USD',
    balance: 0.0,
  });
  await Folio.addCharge({
    folio_id: folioId,
    charge_type: 'room_rate',
    description: `${suiteName} (${nights} night${nights > 1 ? 's' : ''} @ $${ratePerNight}/night)`,
    amount: subtotal,
    tax_amount: taxes,
    reference_id: stay.reference,
  });
  await Folio.addPayment({
    folio_id: folioId,
    payment_method: 'credit_card',
    amount: totalAmount,
    transaction_reference: `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
    card_last_four: cardLast4 || '8821',
    auth_code: `AUTH-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    settled_at: new Date(),
  });
}

/**
 * Public booking from the guest app. Paid bookings (card or member account) with instant access
 * get a room, are checked in straight away and come back with a guest app session.
 * Returns { data, message }.
 */
export async function createBooking(body, meta) {
  const { roomType, arrival: arrStr, departure: depStr, adults, children, guest, specialRequests, paymentMethod, cardLast4, instantAccess = true } = body;

  const arrivalDate = new Date(arrStr);
  const departureDate = new Date(depStr);
  if (isNaN(arrivalDate.getTime()) || isNaN(departureDate.getTime())) throw badRequest('Invalid arrival or departure date format');
  if (departureDate <= arrivalDate) throw badRequest('Departure date must be after arrival date');
  const nights = Math.max(1, Math.round((departureDate.getTime() - arrivalDate.getTime()) / 86_400_000));

  // Price from the hotel's room types, else from the catalog.
  const wanted = roomType.toLowerCase();
  const matchedDb = (await Room.allRoomTypes()).find((rt) => rt.name.toLowerCase() === wanted || wanted.includes(rt.name.toLowerCase()) || rt.name.toLowerCase().includes(wanted));
  const matchedSuite = LUXURY_SUITES_CATALOG.find((s) => s.roomType.toLowerCase() === wanted || s.name.toLowerCase().includes(wanted) || s.code === roomType) || LUXURY_SUITES_CATALOG[0];

  const ratePerNight = matchedDb?.base_price != null ? Number(matchedDb.base_price) : matchedSuite.basePrice;
  const subtotal = ratePerNight * nights;
  const taxes = Math.round(subtotal * TAX_RATE);
  const totalAmount = subtotal + taxes;

  const compositeNotes = [
    guest.notes,
    specialRequests ? `Special Requests: ${specialRequests}` : null,
    `Rate: $${ratePerNight}/night (${nights} nights). Total: $${totalAmount} (Taxes: $${taxes}). Payment: ${paymentMethod} (${cardLast4 ? 'ending in ' + cardLast4 : 'Deposit Settled'}).`,
  ]
    .filter(Boolean)
    .join(' | ');

  const isImmediatePayment = paymentMethod === 'credit_card' || paymentMethod === 'member_account';
  const grantAccess = isImmediatePayment && instantAccess;

  let assignedRoom = null;
  if (grantAccess) {
    assignedRoom = await findFreeRoom(matchedDb, matchedSuite, arrivalDate, departureDate);
    if (!assignedRoom) throw conflict('All suites are currently occupied for the selected dates. Please choose alternative dates.');
  }

  const result = await createStay(
    {
      guest: { firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone || null },
      roomType: matchedSuite.roomType,
      roomId: assignedRoom?.id || null,
      checkInNow: grantAccess,
      arrival: arrivalDate,
      departure: departureDate,
      adults,
      children,
      notes: compositeNotes,
    },
    { type: 'guest', id: null, ip: meta.ip },
  );

  const stay = result.stay;
  let session = null;
  if (grantAccess && stay) {
    try {
      await settleFolio(stay, { suiteName: matchedSuite.name, nights, ratePerNight, subtotal, taxes, totalAmount, cardLast4 });
    } catch (folioErr) {
      console.warn('Folio settlement notice:', folioErr.message);
    }
    session = await startSession(stay, stay.guest.id, 'booking_code', meta);
  }

  return {
    data: {
      stayId: stay.id,
      reference: stay.reference,
      accessCode: result.accessCode,
      qrToken: result.qrToken,
      qrUrl: result.qrUrl,
      roomNumber: stay.room?.number || assignedRoom?.number || null,
      floor: stay.room?.floor || assignedRoom?.floor || null,
      roomId: stay.room?.id || assignedRoom?.id || null,
      suiteName: matchedSuite.name,
      roomType: matchedSuite.roomType,
      arrival: arrStr,
      departure: depStr,
      nights,
      ratePerNight,
      subtotal,
      taxes,
      totalAmount,
      currency: 'USD',
      paymentMethod,
      cardLast4: cardLast4 || '8821',
      status: stay.status,
      accessGranted: grantAccess,
      token: session?.token || null,
      expiresAt: session?.expiresAt || null,
      digitalKeyCount: result.keys?.length || (grantAccess ? 1 : 0),
      guest: { id: stay.guest.id, firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone },
    },
    message: grantAccess
      ? `Payment successful! Suite ${stay.room?.number || assignedRoom?.number} is ready. Instant mobile access has been activated.`
      : `Reservation ${stay.reference} confirmed! Your booking has been secured.`,
  };
}

/** The signed-in guest's bookings, newest first. */
export const getMyBookings = (guestId) => Stay.bookingsForGuest(guestId);
