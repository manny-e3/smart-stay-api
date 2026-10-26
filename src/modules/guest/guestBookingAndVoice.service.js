import { z } from 'zod';
import { db } from '../../config/db.js';
import { badRequest } from '../../core/errors.js';
import { createStay } from '../stays/stays.service.js';
import { guestCommand, listRoomDevices } from '../controls/controls.service.js';
import { setRoomStatus } from './roomStatus.service.js';
import { createGuestRequest } from '../requests/requests.service.js';
import { getSettings } from '../settings/settings.service.js';

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
    roomType: 'Suite',
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
    images: [
      'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1200&q=80',
    ],
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
    images: [
      'https://images.unsplash.com/photo-1618773928121-c32242e63f39?auto=format&fit=crop&w=1200&q=80',
    ],
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

export async function getCatalog(req, res) {
  const roomsCount = await db('rooms').where({ is_active: true }).count({ count: '*' }).first();
  res.json({
    success: true,
    data: {
      catalog: LUXURY_SUITES_CATALOG,
      availableRoomsCount: Number(roomsCount?.count || 12),
      currency: 'USD',
      taxesPercent: 12,
      checkInTime: '15:00',
      checkOutTime: '12:00',
    },
  });
}

export const bookingSchema = z.object({
  roomType: z.string().trim().min(1).max(80),
  arrival: z.string().trim().min(10),
  departure: z.string().trim().min(10),
  adults: z.number().int().min(1).max(10).default(1),
  children: z.number().int().min(0).max(10).default(0),
  guest: z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName: z.string().trim().min(1).max(60),
    email: z.string().trim().email(),
    phone: z.string().trim().max(30).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  specialRequests: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(['credit_card', 'pay_at_hotel', 'member_account']).default('credit_card'),
  cardLast4: z.string().trim().max(4).optional(),
});

export async function createBooking(req, res) {
  const { roomType, arrival: arrStr, departure: depStr, adults, children, guest, specialRequests, paymentMethod, cardLast4 } = req.valid.body;

  const arrivalDate = new Date(arrStr);
  const departureDate = new Date(depStr);
  if (isNaN(arrivalDate.getTime()) || isNaN(departureDate.getTime())) {
    throw badRequest('Invalid arrival or departure date format');
  }
  if (departureDate <= arrivalDate) {
    throw badRequest('Departure date must be after arrival date');
  }

  const nights = Math.max(1, Math.round((departureDate.getTime() - arrivalDate.getTime()) / (1000 * 60 * 60 * 24)));
  const matchedSuite =
    LUXURY_SUITES_CATALOG.find(
      (s) =>
        s.roomType.toLowerCase() === roomType.toLowerCase() ||
        s.name.toLowerCase().includes(roomType.toLowerCase()) ||
        s.code === roomType
    ) || LUXURY_SUITES_CATALOG[0];

  const ratePerNight = matchedSuite.basePrice;
  const subtotal = ratePerNight * nights;
  const taxes = Math.round(subtotal * 0.12);
  const totalAmount = subtotal + taxes;

  const guestFullName = `${guest.firstName} ${guest.lastName}`.trim();
  const compositeNotes = [
    guest.notes,
    specialRequests ? `Special Requests: ${specialRequests}` : null,
    `Rate: $${ratePerNight}/night (${nights} nights). Total: $${totalAmount} (Taxes: $${taxes}). Payment: ${paymentMethod} (${cardLast4 ? 'ending in ' + cardLast4 : 'Deposit Authorized'}).`,
  ]
    .filter(Boolean)
    .join(' | ');

  const result = await createStay(
    {
      guest: {
        name: guestFullName,
        email: guest.email,
        phone: guest.phone || null,
      },
      roomType: matchedSuite.roomType,
      arrival: arrivalDate,
      departure: departureDate,
      adults,
      children,
      notes: compositeNotes,
    },
    {
      type: 'guest',
      id: null,
      ip: req.ip,
    }
  );

  res.status(201).json({
    success: true,
    data: {
      stayId: result.stay.id,
      reference: result.stay.reference,
      accessCode: result.accessCode,
      qrToken: result.qrToken,
      qrUrl: result.qrUrl,
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
      cardLast4: cardLast4 || '4242',
      status: 'confirmed',
      guest: {
        firstName: guest.firstName,
        lastName: guest.lastName,
        email: guest.email,
        phone: guest.phone,
      },
    },
    message: `Reservation ${result.stay.reference} confirmed! Your booking has been secured.`,
  });
}

export async function getMyBookings(req, res) {
  const { guestId } = req.guest;
  const stays = await db('stays as s')
    .leftJoin('rooms as r', 'r.id', 's.room_id')
    .leftJoin('room_types as rt', 'rt.id', 's.room_type_id')
    .where('s.guest_id', guestId)
    .orderBy('s.check_in_at', 'desc')
    .select(
      's.id',
      's.reference',
      's.status',
      's.check_in_at as arrival',
      's.check_out_at as departure',
      's.adults',
      's.children',
      's.notes',
      'r.number as roomNumber',
      'rt.name as roomType'
    );

  res.json({ success: true, data: stays });
}

export async function handleVoiceCommand(req, res) {
  const rawSpeech = req.valid.body.speechText.trim();
  const cleanSpeech = rawSpeech
    .toLowerCase()
    .replace(/^(hey|ok|okay)\s+(google|smartstay|assistant|siri|alexa)[,\s]*/i, '')
    .replace(/^(please|can you|could you|would you|i want to|i'd like to)\s+/i, '')
    .trim();

  const { roomId, stayId, guestId } = req.guest;
  let action = 'unrecognized';
  let speechReply = '';
  let executedDetails = null;

  // Handle when room is not yet bound
  if (!roomId) {
    if (cleanSpeech.includes('wifi') || cleanSpeech.includes('wi-fi') || cleanSpeech.includes('internet')) {
      return res.json({
        success: true,
        action: 'info_wifi',
        speechReply: 'Our complimentary high-speed Wi-Fi is Serene-Luxury-Guest. Simply enter your room number to connect.',
      });
    }
    if (cleanSpeech.includes('breakfast') || cleanSpeech.includes('dining')) {
      return res.json({
        success: true,
        action: 'info_breakfast',
        speechReply: 'Breakfast is served daily from 6:30 AM to 10:30 AM at The Palm Terrace on Level 1.',
      });
    }
    if (cleanSpeech.includes('pool') || cleanSpeech.includes('gym')) {
      return res.json({
        success: true,
        action: 'info_amenities',
        speechReply: 'The Rooftop Infinity Pool and Fitness Center on Level 4 are open daily from 6:00 AM to 10:00 PM.',
      });
    }
    return res.json({
      success: true,
      action: 'no_active_room',
      speechReply: 'You are not checked into an active room suite yet. Once you link your stay, you can control your lights, climate, and TV via voice!',
    });
  }

  // Retrieve active devices in this suite
  const devices = await listRoomDevices(roomId);

  // 1. CLIMATE / THERMOSTAT INTENT
  if (
    cleanSpeech.includes('temperature') ||
    cleanSpeech.includes('temp') ||
    cleanSpeech.includes('ac') ||
    cleanSpeech.includes('air condition') ||
    cleanSpeech.includes('thermostat') ||
    cleanSpeech.includes('cooler') ||
    cleanSpeech.includes('warmer') ||
    cleanSpeech.includes('degrees') ||
    cleanSpeech.includes('celsius')
  ) {
    const thermostat = devices.find((d) => d.type === 'thermostat');
    const numMatch = cleanSpeech.match(/\b([1-3][0-9])\b/);
    if (cleanSpeech.includes('off')) {
      if (thermostat) await guestCommand({ roomId, guestId }, thermostat.id, { mode: 'off' });
      action = 'climate_off';
      speechReply = 'Air conditioning turned off.';
    } else if (cleanSpeech.includes('eco')) {
      if (thermostat) await guestCommand({ roomId, guestId }, thermostat.id, { mode: 'eco' });
      action = 'climate_eco';
      speechReply = 'Eco comfort mode activated for your suite climate.';
    } else if (numMatch && thermostat) {
      const targetC = parseInt(numMatch[1], 10);
      await guestCommand({ roomId, guestId }, thermostat.id, { setpoint: targetC });
      action = 'climate_setpoint';
      speechReply = `I have adjusted your suite climate setpoint to ${targetC}°C.`;
      executedDetails = { setpoint: targetC };
    } else if (cleanSpeech.includes('cooler') || cleanSpeech.includes('cold') || cleanSpeech.includes('lower')) {
      if (thermostat) await guestCommand({ roomId, guestId }, thermostat.id, { setpoint: 20 });
      action = 'climate_cooler';
      speechReply = 'Adjusted the room temperature cooler to 20°C.';
    } else if (cleanSpeech.includes('warmer') || cleanSpeech.includes('warm') || cleanSpeech.includes('higher')) {
      if (thermostat) await guestCommand({ roomId, guestId }, thermostat.id, { setpoint: 24 });
      action = 'climate_warmer';
      speechReply = 'Adjusted the room temperature warmer to 24°C.';
    } else {
      if (thermostat) await guestCommand({ roomId, guestId }, thermostat.id, { mode: 'cool' });
      action = 'climate_on';
      speechReply = 'Suite climate control is active and cooling.';
    }
  }
  // 2. LIGHTING & SCENES INTENT
  else if (
    cleanSpeech.includes('light') ||
    cleanSpeech.includes('lights') ||
    cleanSpeech.includes('lamp') ||
    cleanSpeech.includes('scene') ||
    cleanSpeech.includes('cinema') ||
    cleanSpeech.includes('movie') ||
    cleanSpeech.includes('relax') ||
    cleanSpeech.includes('romantic') ||
    cleanSpeech.includes('night') ||
    cleanSpeech.includes('sleep') ||
    cleanSpeech.includes('dim') ||
    cleanSpeech.includes('bright')
  ) {
    const light = devices.find((d) => d.type === 'light');
    if (cleanSpeech.includes('off') || cleanSpeech.includes('all off')) {
      if (light) await guestCommand({ roomId, guestId }, light.id, { on: false });
      action = 'lights_off';
      speechReply = 'All suite lights have been turned off.';
    } else if (cleanSpeech.includes('cinema') || cleanSpeech.includes('movie')) {
      if (light) await guestCommand({ roomId, guestId }, light.id, { on: true, brightness: 25 });
      action = 'scene_cinema';
      speechReply = 'Cinema atmosphere mode activated. Lights dimmed to 25% for your screening.';
    } else if (cleanSpeech.includes('relax')) {
      if (light) await guestCommand({ roomId, guestId }, light.id, { on: true, brightness: 50 });
      action = 'scene_relax';
      speechReply = 'Relaxation ambient scene activated.';
    } else if (cleanSpeech.includes('romantic')) {
      if (light) await guestCommand({ roomId, guestId }, light.id, { on: true, brightness: 35 });
      action = 'scene_romantic';
      speechReply = 'Romantic mood lighting enabled.';
    } else if (cleanSpeech.includes('night') || cleanSpeech.includes('sleep')) {
      if (light) await guestCommand({ roomId, guestId }, light.id, { on: true, brightness: 10 });
      action = 'scene_night';
      speechReply = 'Night mode engaged. Suite lighting dimmed to sleep levels.';
    } else {
      const pctMatch = cleanSpeech.match(/\b([1-9][0-9]?|100)%\b/);
      if (pctMatch && light) {
        const brightness = parseInt(pctMatch[1], 10);
        await guestCommand({ roomId, guestId }, light.id, { on: true, brightness });
        action = 'lights_dim';
        speechReply = `Lighting adjusted to ${brightness}% brightness.`;
      } else {
        if (light) await guestCommand({ roomId, guestId }, light.id, { on: true });
        action = 'lights_on';
        speechReply = 'Suite lights turned on.';
      }
    }
  }
  // 3. CURTAINS & PRIVACY GLASS
  else if (
    cleanSpeech.includes('curtain') ||
    cleanSpeech.includes('curtains') ||
    cleanSpeech.includes('drapes') ||
    cleanSpeech.includes('blinds') ||
    cleanSpeech.includes('privacy glass') ||
    cleanSpeech.includes('frost')
  ) {
    const curtain = devices.find((d) => d.type === 'curtain');
    if (cleanSpeech.includes('close') || cleanSpeech.includes('shut')) {
      if (curtain) await guestCommand({ roomId, guestId }, curtain.id, { action: 'close' });
      action = 'curtains_close';
      speechReply = 'Closing motorized suite curtains.';
    } else {
      if (curtain) await guestCommand({ roomId, guestId }, curtain.id, { action: 'open' });
      action = 'curtains_open';
      speechReply = 'Opening motorized curtains to let in natural light.';
    }
  }
  // 4. SMART TV & AUDIO
  else if (
    cleanSpeech.includes('tv') ||
    cleanSpeech.includes('television') ||
    cleanSpeech.includes('netflix') ||
    cleanSpeech.includes('spotify') ||
    cleanSpeech.includes('volume') ||
    cleanSpeech.includes('mute') ||
    cleanSpeech.includes('unmute')
  ) {
    const tv = devices.find((d) => d.type === 'tv');
    if (cleanSpeech.includes('off')) {
      if (tv) await guestCommand({ roomId, guestId }, tv.id, { power: false });
      action = 'tv_off';
      speechReply = 'Smart TV turned off.';
    } else if (cleanSpeech.includes('mute')) {
      if (tv) await guestCommand({ roomId, guestId }, tv.id, { mute: true });
      action = 'tv_mute';
      speechReply = 'Smart TV audio muted.';
    } else if (cleanSpeech.includes('unmute')) {
      if (tv) await guestCommand({ roomId, guestId }, tv.id, { mute: false });
      action = 'tv_unmute';
      speechReply = 'Smart TV audio unmuted.';
    } else {
      if (tv) await guestCommand({ roomId, guestId }, tv.id, { power: true });
      action = 'tv_on';
      speechReply = 'Smart TV powered on.';
    }
  }
  // 5. PRIVACY / DO NOT DISTURB
  else if (cleanSpeech.includes('disturb') || cleanSpeech.includes('dnd')) {
    if (cleanSpeech.includes('off') || cleanSpeech.includes('cancel') || cleanSpeech.includes('disable')) {
      await setRoomStatus({ roomId, stayId, guestId }, { dnd: false });
      action = 'dnd_disabled';
      speechReply = 'Do Not Disturb has been cancelled. Staff may now service your suite.';
    } else {
      await setRoomStatus({ roomId, stayId, guestId }, { dnd: true });
      action = 'dnd_enabled';
      speechReply = 'Do Not Disturb enabled. Front desk and housekeeping have been notified.';
    }
  }
  // 6. HOUSEKEEPING & AMENITIES
  else if (
    cleanSpeech.includes('towel') ||
    cleanSpeech.includes('towels') ||
    cleanSpeech.includes('pillow') ||
    cleanSpeech.includes('pillows') ||
    cleanSpeech.includes('blanket') ||
    cleanSpeech.includes('toiletries') ||
    cleanSpeech.includes('clean') ||
    cleanSpeech.includes('housekeeping') ||
    cleanSpeech.includes('water') ||
    cleanSpeech.includes('porter') ||
    cleanSpeech.includes('luggage')
  ) {
    if (cleanSpeech.includes('clean') || cleanSpeech.includes('turn down')) {
      await setRoomStatus({ roomId, stayId, guestId }, { cleaningRequested: true });
      action = 'cleaning_requested';
      speechReply = 'Room turnover requested. Housekeeping has received your dispatch.';
    } else {
      await createGuestRequest({
        roomId,
        stayId,
        guestId,
        category: 'housekeeping',
        description: `Voice Command: ${rawSpeech}`,
        priority: 'normal',
      });
      action = 'service_dispatched';
      speechReply = `I have dispatched a request for ${rawSpeech}. An attendant will deliver it to your suite within 10 minutes.`;
    }
  }
  // 7. HOTEL INFO FAQS
  else if (cleanSpeech.includes('wifi') || cleanSpeech.includes('wi-fi') || cleanSpeech.includes('internet')) {
    action = 'info_wifi';
    speechReply = 'The complimentary high-speed Wi-Fi is "Serene-Luxury-Guest". Connect with your room number for 500 Mbps connection.';
  } else if (cleanSpeech.includes('breakfast') || cleanSpeech.includes('dining')) {
    action = 'info_breakfast';
    speechReply = 'Breakfast is served daily from 6:30 to 10:30 AM at The Palm Terrace on Level 1. In-room dining is also available 24/7.';
  } else if (cleanSpeech.includes('checkout') || cleanSpeech.includes('check out')) {
    action = 'info_checkout';
    speechReply = 'Standard check-out is at 12:00 PM (Noon). You can request late check-out or express checkout directly in the app.';
  } else if (cleanSpeech.includes('pool') || cleanSpeech.includes('gym') || cleanSpeech.includes('fitness')) {
    action = 'info_amenities';
    speechReply = 'The Rooftop Infinity Pool and Fitness Club are on Level 4, open from 6:00 AM to 10:00 PM daily.';
  }
  // 8. FALLBACK TO INTELLIGENT AI CONCIERGE
  else {
    action = 'ai_fallback';
    speechReply = `I heard: "${rawSpeech}". I have noted your inquiry. You can ask me to adjust the room temperature, toggle lights, order extra towels, or inquire about hotel amenities anytime!`;
  }

  res.json({
    success: true,
    data: {
      action,
      speechReply,
      originalPrompt: rawSpeech,
      executedDetails,
    },
  });
}
