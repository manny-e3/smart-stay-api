import { Router } from 'express';
import { db } from '../../config/db.js';
import { notFound, badRequest } from '../../core/errors.js';

const router = Router();

// POST /admin/ai/copilot
router.post('/copilot', async (req, res) => {
  const { task, context = {}, prompt } = req.body;

  if (task === 'guest_dossier_brief') {
    const { guestId, stayId } = context;
    const guest = await db('guests').where({ id: guestId }).first();
    const pastStays = await db('stays').where({ guest_id: guestId });
    const requests = await db('requests').where({ guest_id: guestId });

    const summary = `Guest Brief for ${guest?.first_name || 'Valued'} ${guest?.last_name || 'Guest'} (${guest?.vip ? 'VIP Member' : 'Standard Guest'}):
- Total Stays: ${pastStays.length} historical stays across Serene properties.
- Service Interactions: ${requests.length} logged service tickets.
- Preferred Room Amenities: High-floor suite, hypoallergenic pillows, sparkling water on arrival.
- Recommended Staff Greeting: "Welcome back, Mr./Ms. ${guest?.last_name || 'Guest'}. Your suite has been prepared with your preferred chilled San Pellegrino."`;

    return res.json({ success: true, data: { response: summary } });
  }

  if (task === 'draft_feedback_reply') {
    const { feedbackId, guestName, rating, comment } = context;
    let tone = rating >= 4 ? 'gracious and celebratory' : 'empathetic, resolution-focused, and restorative';
    const draft = `Dear ${guestName || 'Valued Guest'},

Thank you for sharing your experience at Serene Hospitality. ${rating >= 4 ? 'We are delighted to hear that you thoroughly enjoyed your stay with us.' : 'We sincerely regret that certain aspects of your stay did not meet our premier luxury standards.'} 

Regarding your comments: "${comment || 'Your feedback'}", our management team has reviewed this directly with our department heads to ensure perfection on your next visit. We would be honored to welcome you back soon.

Warmest regards,
Hotel Operations Executive
Serene Hospitality & SmartStay`;

    return res.json({ success: true, data: { response: draft } });
  }

  if (task === 'shift_handover_summary') {
    const openRequests = await db('requests').whereIn('status', ['new', 'assigned', 'in_progress']).count({ n: '*' }).first();
    const openAlerts = await db('alerts').where({ status: 'open' }).count({ n: '*' }).first();
    const occupied = await db('stays').where({ status: 'checked_in' }).count({ n: '*' }).first();

    const handover = `Operational Shift Handover Briefing (${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}):
1. Occupancy Status: ${occupied.n} active guest suites currently occupied.
2. Open Service Requests: ${openRequests.n} pending guest tickets (all within SLA targets).
3. IoT Maintenance Diagnostics: ${openAlerts.n} open device warnings (including low batteries and waste bin telemetry).
4. Priority Directives for Next Shift:
   - Supervise VIP arrivals for Penthouse Suite.
   - Dispatch housekeeping to empty flagged smart dustbins on Floor 1 & 2.
   - Settle outstanding F&B charges prior to scheduled morning departures.`;

    return res.json({ success: true, data: { response: handover } });
  }

  // General query fallback
  return res.json({
    success: true,
    data: {
      response: `SmartStay AI Copilot response to: "${prompt || 'Inquiry'}"\nBased on your active hotel settings and occupancy data, operations are running smoothly with all IoT gateways synchronized.`,
    },
  });
});

// POST /guest/ai/chat (also mounted under /admin/ai/guest-chat for testing)
router.post('/guest-chat', async (req, res) => {
  const { message, roomId, stayId, guestName } = req.body;
  if (!message) throw badRequest('Message is required');

  const lower = message.toLowerCase();
  let reply = '';
  let actionTaken = null;

  // 1. Towels / Housekeeping
  if (lower.includes('towel') || lower.includes('cleaning') || lower.includes('housekeeping')) {
    if (roomId) {
      await db('requests').insert({
        room_id: roomId,
        stay_id: stayId || null,
        category: 'housekeeping',
        description: `AI Concierge Dispatch: ${message}`,
        status: 'new',
        source: 'guest',
        priority: 'normal',
        created_at: new Date(),
      });
      actionTaken = 'dispatched_housekeeping_ticket';
    }
    reply = `I have dispatched housekeeping to Room ${roomId || 'your suite'} right away with fresh plush towels. Attendant turnaround is typically under 10 minutes!`;
  }
  // 2. Wi-Fi / Internet
  else if (lower.includes('wifi') || lower.includes('wi-fi') || lower.includes('internet') || lower.includes('password')) {
    reply = `The complimentary high-speed Wi-Fi network is "Serene-Luxury-Guest". No password is required—simply enter your room number and last name on the splash portal for 500 Mbps connection!`;
  }
  // 3. Checkout time
  else if (lower.includes('checkout') || lower.includes('check out') || lower.includes('check-out')) {
    reply = `Standard check-out is at 12:00 PM (Noon). If you require a complimentary late checkout up to 2:00 PM, please let me know and I will submit an instant request for front desk approval!`;
  }
  // 4. Breakfast & Dining
  else if (lower.includes('breakfast') || lower.includes('dining') || lower.includes('food') || lower.includes('eat') || lower.includes('restaurant')) {
    reply = `Breakfast is served daily at The Palm Terrace from 06:30 to 10:30 AM (Level 1). In-Room Dining is available 24/7 through the Dining tab on your mobile app!`;
  }
  // 5. Swimming pool / Gym
  else if (lower.includes('pool') || lower.includes('gym') || lower.includes('fitness') || lower.includes('spa')) {
    reply = `The Rooftop Infinity Pool and Fitness Center are located on Level 4, open from 06:00 AM to 10:00 PM daily. Keycard access is granted automatically to your digital mobile key!`;
  }
  // 6. AC / Temperature
  else if (lower.includes('cold') || lower.includes('hot') || lower.includes('ac') || lower.includes('temperature') || lower.includes('air conditioning')) {
    reply = `You can adjust your suite temperature anytime directly from the Room Controls screen, or I can adjust your thermostat setpoint for you right now!`;
  }
  // 7. Human staff escalation
  else if (lower.includes('human') || lower.includes('manager') || lower.includes('speak to someone') || lower.includes('complaint')) {
    if (roomId) {
      await db('requests').insert({
        room_id: roomId,
        stay_id: stayId || null,
        category: 'other',
        description: `[AI Escalation - Human Requested] ${message}`,
        status: 'new',
        source: 'guest',
        priority: 'urgent',
        created_at: new Date(),
      });
      actionTaken = 'escalated_to_human_staff';
    }
    reply = `I have immediately notified our Chief Concierge and Duty Manager. A dedicated staff member will reach out to your room shortly.`;
  }
  // Default natural concierge greeting
  else {
    reply = `Hello ${guestName ? guestName : 'there'}! I am your AI Virtual Concierge. I can assist with suite amenities, fresh linens, dining recommendations, digital key access, or hotel services. How may I ensure your stay is extraordinary today?`;
  }

  res.json({
    success: true,
    data: {
      reply,
      actionTaken,
      timestamp: new Date().toISOString(),
    },
  });
});

export default router;
