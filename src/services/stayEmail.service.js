import { sendEmail } from './notification.service.js';

/**
 * Booking emails to guests: the reservation confirmation and the check-in welcome,
 * both with the guest app login details (booking reference, last name, access code and link).
 */

export async function emailGuestReservation(stay, code, qrUrl, settings, isCheckIn = false) {
  if (!stay?.guest?.email) return;
  const hotelName = settings?.hotel_name || 'SmartStay Hotel';
  const roomNumber = stay.room?.number ? `Room ${stay.room.number}` : 'Allocated at Check-in';
  const arrivalDate = stay.arrival || stay.check_in_at;
  const departureDate = stay.departure || stay.check_out_at;
  const arrivalStr = arrivalDate ? new Date(arrivalDate).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) : 'Scheduled';
  const departureStr = departureDate ? new Date(departureDate).toLocaleDateString([], {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }) : 'Scheduled';
  
  const appBase = settings?.guest_app_login_url || 'http://localhost:5173';
  const appUrl = qrUrl || `${appBase}?ref=${encodeURIComponent(stay.reference || '')}&lastName=${encodeURIComponent(stay.guest?.lastName || '')}&code=${encodeURIComponent(code || '')}`;

  const subject = isCheckIn
    ? `Welcome to ${hotelName} - ${roomNumber} [Access Code: ${code || stay.reference}]`
    : `Reservation Confirmed: ${stay.reference} - ${hotelName}`;

  const textLines = [
    `Dear ${stay.guest.firstName} ${stay.guest.lastName},`,
    '',
    isCheckIn
      ? `Welcome to ${hotelName}! You are checked in to ${roomNumber}.`
      : `Thank you for choosing ${hotelName}. Your reservation has been successfully confirmed.`,
    '',
    '=== YOUR STAY DETAILS ===',
    `Booking Reference: ${stay.reference}`,
    `Assigned Suite:    ${roomNumber}`,
    `Check-in Date:     ${arrivalStr} (from 2:00 PM)`,
    `Check-out Date:    ${departureStr} (until 11:00 AM)`,
    `Guests:            ${stay.adults || 1} Adult(s)${stay.children ? ', ' + stay.children + ' Children' : ''}`,
    stay.notes ? `Special Requests:  ${stay.notes}` : '',
    '',
    '=== SMARTSTAY GUEST APP LOGIN DETAILS ===',
    'Open the SmartStay mobile app or web portal on your phone to access keyless door entry, climate control, and digital concierge services.',
    '',
    'Sign In Method 1 (Booking Reference & Last Name):',
    `  Booking Reference: ${stay.reference}`,
    `  Last Name:         ${stay.guest.lastName}`,
    '',
    code ? `Sign In Method 2 (Direct Digital Access Code):\n  Access Code:       ${code}\n` : '',
    `Direct Mobile Access Link: ${appUrl}`,
    '',
    'We look forward to providing you with an exceptional stay.',
    '',
    'Warm regards,',
    `Front Desk & Guest Services | ${hotelName}`
  ].filter(Boolean);

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F7F7F5; margin: 0; padding: 24px; color: #1A1C1B; }
        .card { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #E5E7EB; overflow: hidden; box-shadow: 0 4px 16px rgba(11,31,58,0.06); }
        .header { background: #0B1F3A; padding: 32px 28px; text-align: center; color: #ffffff; }
        .logo-pill { display: inline-block; padding: 4px 12px; background: rgba(201,162,39,0.2); border: 1px solid #C9A227; border-radius: 20px; color: #ECC246; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 12px; }
        .title { margin: 0; font-size: 22px; font-weight: 700; color: #ffffff; }
        .content { padding: 32px 28px; line-height: 1.6; font-size: 14px; }
        .credentials-box { background: #F9F9F7; border: 2px dashed #C9A227; border-radius: 12px; padding: 20px; margin: 24px 0; }
        .cred-item { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; font-size: 14px; }
        .cred-label { color: #64748B; font-weight: 600; }
        .cred-value { font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; font-size: 16px; font-weight: 800; color: #0B1F3A; background: #ffffff; padding: 2px 8px; border-radius: 6px; border: 1px solid #E5E7EB; }
        .table-info { width: 100%; border-collapse: collapse; margin: 20px 0; }
        .table-info td { padding: 10px 0; border-bottom: 1px solid #F1F5F9; font-size: 13px; }
        .table-info td:first-child { color: #64748B; width: 40%; font-weight: 600; }
        .table-info td:last-child { color: #0B1F3A; font-weight: 600; }
        .btn-cta { display: inline-block; padding: 12px 28px; background: #0B1F3A; color: #ffffff !important; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 13px; margin: 16px 0; }
        .footer { padding: 20px 28px; background: #F9F9F7; border-top: 1px solid #E5E7EB; text-align: center; font-size: 12px; color: #64748B; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="header">
          <div class="logo-pill">${hotelName}</div>
          <h1 class="title">${isCheckIn ? 'Welcome to Your Suite' : 'Reservation Confirmed'}</h1>
          <p style="margin: 6px 0 0; color: #B5C7EA; font-size: 13px;">Booking Reference: <strong>${stay.reference}</strong></p>
        </div>
        <div class="content">
          <p>Dear <strong>${stay.guest.firstName} ${stay.guest.lastName}</strong>,</p>
          <p>${isCheckIn ? `Welcome to <strong>${hotelName}</strong>! You are checked in to <strong>${roomNumber}</strong>.` : `We are delighted to confirm your upcoming reservation at <strong>${hotelName}</strong>. Your suite is being prepared for your arrival.`}</p>
          
          <div class="credentials-box">
            <div style="font-size: 12px; font-weight: 700; text-transform: uppercase; color: #B45309; letter-spacing: 0.05em; margin-bottom: 12px;">
              🔑 SmartStay Guest Mobile App Login Details
            </div>
            <div class="cred-item">
              <span class="cred-label">Booking Reference:</span>
              <span class="cred-value">${stay.reference}</span>
            </div>
            <div class="cred-item">
              <span class="cred-label">Last Name:</span>
              <span class="cred-value">${stay.guest.lastName}</span>
            </div>
            ${code ? `
            <div class="cred-item">
              <span class="cred-label">Digital Access Code:</span>
              <span class="cred-value" style="color: #B45309; border-color: #C9A227;">${code}</span>
            </div>` : ''}
            <div style="text-align: center; margin-top: 16px;">
              <a href="${appUrl}" class="btn-cta">Open Guest Mobile Portal</a>
            </div>
          </div>

          <h3 style="font-size: 15px; color: #0B1F3A; margin-top: 24px; margin-bottom: 8px;">Itinerary & Reservation Summary</h3>
          <table class="table-info">
            <tr>
              <td>Allocated Suite</td>
              <td><strong>${roomNumber}</strong></td>
            </tr>
            <tr>
              <td>Check-in Date</td>
              <td>${arrivalStr} (from 2:00 PM)</td>
            </tr>
            <tr>
              <td>Check-out Date</td>
              <td>${departureStr} (until 11:00 AM)</td>
            </tr>
            <tr>
              <td>Guests</td>
              <td>${stay.adults || 1} Adult(s)${stay.children ? ', ' + stay.children + ' Children' : ''}</td>
            </tr>
            ${stay.notes ? `<tr><td>Special Requests</td><td>${stay.notes}</td></tr>` : ''}
          </table>

          <p style="font-size: 12px; color: #64748B; margin-top: 20px;">
            With the SmartStay app on your mobile device, you can unlock your door digitally, adjust climate & lighting, and message the concierge team 24/7.
          </p>
        </div>
        <div class="footer">
          <p style="margin: 0;">We look forward to welcoming you to ${hotelName}.</p>
          <p style="margin: 4px 0 0; font-size: 11px; color: #94A3B8;">For any inquiries or assistance, please contact the front desk.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    await sendEmail({
      to: stay.guest.email,
      subject,
      text: textLines.join('\n'),
      html,
    });
    console.log(`[Reservation Email] Sent login details to ${stay.guest.email} for booking ${stay.reference}`);
  } catch (err) {
    console.error('[Reservation Email] Failed to send email:', err.message);
  }
}
