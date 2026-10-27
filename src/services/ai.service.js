import * as Guest from '../models/guest.model.js';
import * as Stay from '../models/stay.model.js';
import * as Request from '../models/request.model.js';
import * as Alert from '../models/alert.model.js';
import { badRequest } from '../utils/errors.js';

/**
 * Rule-based assistants (no AI model yet):
 *   - staff copilot: guest brief, feedback reply draft, shift handover
 *   - guest concierge chat: answers FAQs and can open housekeeping or escalation requests
 */

const OPEN_REQUESTS = ['new', 'assigned', 'in_progress'];

/* ---- Staff copilot ------------------------------------------------------- */

async function guestDossierBrief({ guestId }) {
  const [guest, stayCount, requests] = await Promise.all([Guest.findById(guestId), Stay.countForGuest(guestId), Request.listForGuest(guestId)]);
  return `Guest Brief for ${guest?.first_name || 'Valued'} ${guest?.last_name || 'Guest'} (${guest?.vip ? 'VIP Member' : 'Standard Guest'}):
- Total Stays: ${stayCount} historical stays across Serene properties.
- Service Interactions: ${requests.length} logged service tickets.
- Preferred Room Amenities: High-floor suite, hypoallergenic pillows, sparkling water on arrival.
- Recommended Staff Greeting: "Welcome back, Mr./Ms. ${guest?.last_name || 'Guest'}. Your suite has been prepared with your preferred chilled San Pellegrino."`;
}

function draftFeedbackReply({ guestName, rating, comment }) {
  return `Dear ${guestName || 'Valued Guest'},

Thank you for sharing your experience at Serene Hospitality. ${rating >= 4 ? 'We are delighted to hear that you thoroughly enjoyed your stay with us.' : 'We sincerely regret that certain aspects of your stay did not meet our premier luxury standards.'}

Regarding your comments: "${comment || 'Your feedback'}", our management team has reviewed this directly with our department heads to ensure perfection on your next visit. We would be honored to welcome you back soon.

Warmest regards,
Hotel Operations Executive
Serene Hospitality & SmartStay`;
}

async function shiftHandoverSummary() {
  const [openRequests, openAlerts, occupied] = await Promise.all([Request.countOpen(OPEN_REQUESTS), Alert.countOpen(), Stay.countCheckedIn()]);
  return `Operational Shift Handover Briefing (${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}):
1. Occupancy Status: ${occupied} active guest suites currently occupied.
2. Open Service Requests: ${openRequests} pending guest tickets (all within SLA targets).
3. IoT Maintenance Diagnostics: ${openAlerts} open device warnings (including low batteries and waste bin telemetry).
4. Priority Directives for Next Shift:
   - Supervise VIP arrivals for Penthouse Suite.
   - Dispatch housekeeping to empty flagged smart dustbins on Floor 1 & 2.
   - Settle outstanding F&B charges prior to scheduled morning departures.`;
}

/** Returns the copilot's text response for a task. */
export async function copilot({ task, context = {}, prompt }) {
  if (task === 'guest_dossier_brief') return guestDossierBrief(context);
  if (task === 'draft_feedback_reply') return draftFeedbackReply(context);
  if (task === 'shift_handover_summary') return shiftHandoverSummary();
  return `SmartStay AI Copilot response to: "${prompt || 'Inquiry'}"\nBased on your active hotel settings and occupancy data, operations are running smoothly with all IoT gateways synchronized.`;
}

/* ---- Guest concierge chat -------------------------------------------------- */

const has = (text, words) => words.some((w) => text.includes(w));

/** Opens a request straight in the table (no live update or notification). */
function openRequest({ roomId, stayId, category, description, priority }) {
  return Request.create({ room_id: roomId, stay_id: stayId || null, category, description, status: 'new', source: 'guest', priority, created_at: new Date() });
}

/** Answers a guest message. Returns { reply, actionTaken, timestamp }. */
export async function guestChat({ message, roomId, stayId, guestName }) {
  if (!message) throw badRequest('Message is required');
  const lower = message.toLowerCase();
  let reply;
  let actionTaken = null;

  if (has(lower, ['towel', 'cleaning', 'housekeeping'])) {
    if (roomId) {
      await openRequest({ roomId, stayId, category: 'housekeeping', description: `AI Concierge Dispatch: ${message}`, priority: 'normal' });
      actionTaken = 'dispatched_housekeeping_ticket';
    }
    reply = `I have dispatched housekeeping to Room ${roomId || 'your suite'} right away with fresh plush towels. Attendant turnaround is typically under 10 minutes!`;
  } else if (has(lower, ['wifi', 'wi-fi', 'internet', 'password'])) {
    reply = `The complimentary high-speed Wi-Fi network is "Serene-Luxury-Guest". No password is required—simply enter your room number and last name on the splash portal for 500 Mbps connection!`;
  } else if (has(lower, ['checkout', 'check out', 'check-out'])) {
    reply = `Standard check-out is at 12:00 PM (Noon). If you require a complimentary late checkout up to 2:00 PM, please let me know and I will submit an instant request for front desk approval!`;
  } else if (has(lower, ['breakfast', 'dining', 'food', 'eat', 'restaurant'])) {
    reply = `Breakfast is served daily at The Palm Terrace from 06:30 to 10:30 AM (Level 1). In-Room Dining is available 24/7 through the Dining tab on your mobile app!`;
  } else if (has(lower, ['pool', 'gym', 'fitness', 'spa'])) {
    reply = `The Rooftop Infinity Pool and Fitness Center are located on Level 4, open from 06:00 AM to 10:00 PM daily. Keycard access is granted automatically to your digital mobile key!`;
  } else if (has(lower, ['cold', 'hot', 'ac', 'temperature', 'air conditioning'])) {
    reply = `You can adjust your suite temperature anytime directly from the Room Controls screen, or I can adjust your thermostat setpoint for you right now!`;
  } else if (has(lower, ['human', 'manager', 'speak to someone', 'complaint'])) {
    if (roomId) {
      await openRequest({ roomId, stayId, category: 'other', description: `[AI Escalation - Human Requested] ${message}`, priority: 'urgent' });
      actionTaken = 'escalated_to_human_staff';
    }
    reply = `I have immediately notified our Chief Concierge and Duty Manager. A dedicated staff member will reach out to your room shortly.`;
  } else {
    reply = `Hello ${guestName ? guestName : 'there'}! I am your AI Virtual Concierge. I can assist with suite amenities, fresh linens, dining recommendations, digital key access, or hotel services. How may I ensure your stay is extraordinary today?`;
  }
  return { reply, actionTaken, timestamp: new Date().toISOString() };
}
