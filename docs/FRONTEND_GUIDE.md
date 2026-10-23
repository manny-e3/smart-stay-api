# SmartStay API: frontend integration guide

For the staff dashboard (web) and the guest app (mobile). The full endpoint reference, with every field and
every role, is the OpenAPI spec:

| What | Where |
|---|---|
| Interactive docs (try requests in the browser) | `http://localhost:5000/docs` |
| OpenAPI spec | `http://localhost:5000/docs/openapi.json` or [docs/openapi.json](openapi.json) |
| Postman collection | [postman/](../postman/) |

Generate TypeScript types from the spec instead of writing them by hand:

```bash
npx openapi-typescript http://localhost:5000/docs/openapi.json -o src/api/schema.d.ts
```

---

## 1. Basics

- **Base URL:** `http://localhost:5000` in development. Every route also works under `/api`.
- **JSON in, JSON out.** Success: `{ "success": true, "data": ... }`.
- **Errors:** `{ "success": false, "code": "BAD_REQUEST", "message": "...", "details": [{ "field": "body.email", "message": "..." }] }`.
  `message` is safe to show to staff. `details` maps validation errors to form fields (strip the `body.` / `query.` prefix).
- **Dates:** ISO 8601 in UTC (`2026-10-22T13:00:00.000Z`). Convert to the hotel time zone for display; the zone is in hotel settings (`timezone`, e.g. `Africa/Lagos`).
- **Lists:** `?page=1&limit=25` and the response `data` is `{ items, page, limit, total }`.
- **Images:** room photos come back as paths like `/uploads/room-123.jpg`; prefix them with the API origin.
- **CORS:** add the dashboard origin to `CORS_ORIGIN` in the API's `.env` (comma-separated).

### Error codes worth handling

| HTTP | `code` | What the UI should do |
|---|---|---|
| 400 | `BAD_REQUEST` | Show `message`; highlight fields from `details` |
| 401 | `TOKEN_EXPIRED` | Refresh the token and retry (see below) |
| 401 | `SESSION_INVALID`, `REFRESH_INVALID` | Session ended (logged out, deactivated, role changed): go to login |
| 401 | `OTP_REQUIRED` | Show the one-time code field and log in again with `otp` |
| 401 | `INVALID_CREDENTIALS`, `INVALID_OTP` | Show the message on the login form |
| 403 | `FORBIDDEN` | The role can't do this; hide the control |
| 404 | `NOT_FOUND` | Item was removed; refresh the list |
| 409 | `CONFLICT` | Show `message` (room occupied, booking overlaps, duplicate email) |
| 423 | `ACCOUNT_LOCKED` | Too many attempts; ask to wait or contact an admin |
| 429 | `RATE_LIMITED` | Back off and retry later |
| 502 | `UNLOCK_FAILED`, `PMS_UNREACHABLE` | The lock or PMS didn't respond; show `message` and offer retry |
| 500 | `INTERNAL` | Unexpected error; show a generic message |

---

## 2. Staff sign-in and tokens

1. `POST /staff/login` with `{ email, password }`.
   - `401 OTP_REQUIRED`: the account uses an authenticator app. Show a 6-digit field and call again with `{ email, password, otp }`.
2. Keep `accessToken` **in memory** (not localStorage). It lasts 15 minutes (`expiresIn` seconds).
3. The refresh token is set as an httpOnly cookie (`ss_refresh`, path `/staff`). Call `POST /staff/refresh` with
   `credentials: 'include'` to get a new access token. Do this on app start (to restore the session) and when a call
   returns `401 TOKEN_EXPIRED`.
   - The cookie only travels when the dashboard and API are on the same site (e.g. `localhost:5173` and `localhost:5000`,
     or `admin.hotel.com` and `api.hotel.com`). If they are on different sites, keep the `refreshToken` from the login
     response and send it in the body: `POST /staff/refresh { refreshToken }`.
4. `POST /staff/logout` on sign-out.
5. `GET /staff/me` returns the profile and `role`; use the role to build the navigation (section 3).

### Fetch client with automatic refresh (TypeScript)

```ts
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:5000';
let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: { field: string; message: string }[]) {
    super(message);
  }
}

async function refreshToken(): Promise<string | null> {
  // One refresh at a time, even if many requests fail together.
  refreshing ??= fetch(`${API}/staff/refresh`, { method: 'POST', credentials: 'include' })
    .then(async (r) => (r.ok ? (accessToken = (await r.json()).data.accessToken) : (accessToken = null)))
    .finally(() => (refreshing = null));
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : null;
  if (res.status === 401 && body?.code === 'TOKEN_EXPIRED' && retry && (await refreshToken())) {
    return api<T>(path, init, false);
  }
  if (!res.ok) throw new ApiError(res.status, body?.code ?? 'ERROR', body?.message ?? res.statusText, body?.details);
  return body.data as T;
}

export async function login(email: string, password: string, otp?: string) {
  const data = await api<{ accessToken: string; staff: { role: string } }>('/staff/login', { method: 'POST', json: { email, password, otp } });
  accessToken = data.accessToken;
  return data.staff;
}

// Usage
const board = await api('/admin/rooms/board?floor=1,2');
await api(`/admin/requests/${id}`, { method: 'PATCH', json: { status: 'in_progress' } });
```

### One-time code (settings page)

`POST /staff/me/otp/setup` returns `otpauthUrl`; render it as a QR code (e.g. the `qrcode` package), then
`POST /staff/me/otp/enable { code }` with a code from the authenticator app.

---

## 3. Roles and navigation

The API enforces permissions; the dashboard should hide what a role can't use.

| Screen | service | maintenance | front_desk | manager | admin |
|---|---|---|---|---|---|
| Room board, room detail | ✓ | ✓ | ✓ | ✓ | ✓ |
| Request queue | ✓ | | | ✓ | ✓ |
| Alerts | | ✓ | | ✓ | ✓ |
| Front desk, stays, guests | | | ✓ | ✓ | ✓ |
| Feedback, audit log, energy | | | | ✓ | ✓ |
| Staff, settings, rooms and devices, rules, PMS | | | | | ✓ |

Each operation in `/docs` lists its roles (also as `x-roles` in the spec). Room detail returns guest phone, email,
last name and booking reference only to front desk, manager and admin.

---

## 4. Live updates (Socket.IO)

```ts
import { io } from 'socket.io-client';

const socket = io(API, { auth: { token: accessToken }, transports: ['websocket'] });

socket.on('connect_error', async () => {
  // Token expired or invalid: refresh, then reconnect with the new token.
  if (await refreshToken()) {
    socket.auth = { token: accessToken };
    socket.connect();
  }
});

socket.on('board:room', (room) => boardStore.upsertRoom(room));   // same shape as a board room
socket.on('board:refresh', () => boardStore.reload());             // mapping changed: reload GET /admin/rooms/board
socket.on('request:created', (r) => { queue.add(r); playSound(); });
socket.on('request:updated', (r) => queue.update(r));              // status, assignee or escalation changed
socket.on('alert:created', (a) => alerts.add(a));
socket.on('alert:updated', (a) => alerts.update(a));               // grouped repeat or resolved
socket.on('stay:updated', ({ stayId }) => frontDesk.reloadStay(stayId));
socket.on('notification', (n) => { toast(n.title, n.body); if (n.data?.sound) playSound(); });
```

Every role only receives events it is allowed to see. Reconnect with a fresh token after each refresh.

| Event | Who receives it | Payload |
|---|---|---|
| `board:room` | all staff | Room summary (as in the board) |
| `board:refresh` | all staff | `{}` |
| `request:created`, `request:updated` | service, manager, admin | Request |
| `alert:created`, `alert:updated` | maintenance, manager, admin | Alert |
| `feedback:created` | manager, admin | `{ id, roomId, roomNumber, rating, category, comment }` |
| `stay:updated` | front desk, manager, admin | `{ stayId, action }` |
| `adapter:health`, `rule:run` | admin | `{ adapterId, from, to }`, `{ ruleId, run }` |
| `notification` | depends on the event | `{ title, body, data, at }`; `data.type` is request, alert, request_escalated or low_rating |

### Browser notifications (optional)

1. `GET /staff/push/public-key` returns the VAPID key (`null` means push isn't configured).
2. In a service worker: `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
3. `POST /staff/me/push-subscriptions` with `subscription.toJSON()`.
4. The service worker's `push` event receives `{ title, body, data }`.

---

## 5. Screens

### Room board
- `GET /admin/rooms/board` with optional `floor=1,2`, `status=alert,request`, `roomType=Suite`.
- Render `floors[].rooms[]`. Rooms are already sorted by urgency. Colour by `status`:
  `alert` (open alert), `request` (open request), `dnd`, `occupied`, `vacant`.
- Badges: `escalatedRequests`, `alertSeverity`, `devicesOffline`, `arrivalToday`, `departureToday`, `checkOutOverdue`.
- `counts` gives the totals for the filter chips.
- Keep live with `board:room` (replace the room with the same `id`) and `board:refresh`.

### Room detail panel
- `GET /admin/rooms/{id}`: `stay`, open `requests`, open `alerts`, `devices` with `online` and `state`, `recentFeedback`.

### Request queue
- `GET /admin/requests?status=new,assigned,in_progress`. One column per status; `openCounts` for the headers.
  Already sorted: escalated, then urgent, then oldest. `escalated: true` should be highlighted.
- "My tasks": `?assignedTo=me`.
- Detail and history: `GET /admin/requests/{id}`.
- Actions, all `PATCH /admin/requests/{id}`:
  - Assign: `{ "assignedTo": 12 }` (a new request becomes `assigned`). Unassign: `{ "assignedTo": null }`.
  - Start: `{ "status": "in_progress" }`. Done: `{ "status": "done" }`. Cancel: `{ "status": "cancelled", "note": "..." }`.
  - Note only: `{ "note": "..." }`. Priority: `{ "priority": "urgent" }`.
- Assignee picker: `GET /admin/requests/assignees` returns active staff who can take requests, with their `openRequests` count.
- New request for a guest: `POST /admin/requests { roomId, category, description, priority }`.
- Play a sound on `request:created` and on notifications with `data.sound`.

### Alerts
- `GET /admin/alerts?status=open` (`openCounts` per severity). Filters: `severity`, `type`, `source=guest` for guest-reported issues.
- `GET /admin/alerts/{id}` for `deviceHistory` and `occurrences`.
- Resolve: `PATCH /admin/alerts/{id} { "status": "resolved", "note": "Replaced the battery" }`. The note is required.

### Feedback
- `GET /admin/feedback?groupBy=week&from=...&to=...`. Use `summary.average`, `summary.distribution` (1 to 5) and
  `averages.periods` for the chart. `items[].photos[].url` for the photo viewer.

### Staff accounts (admin)
- `GET /admin/staff`, `POST /admin/staff { name, email, role, password }`, `PATCH /admin/staff/{id}`.
- Deactivate `{ isActive: false }`, reset password `{ password }`, unlock `{ unlock: true }`, reset authenticator `{ resetOtp: true }`.
- Passwords need 10+ characters with a letter and a number.

### Hotel settings (admin)
- `GET /admin/settings`; `PUT /admin/settings` with only the changed fields.

### Rooms and devices (admin)
- Simple room editing: `POST /admin/rooms`, `PATCH /admin/rooms/{id}`, `DELETE /admin/rooms/{id}`.
- Photos: read the file with `FileReader.readAsDataURL`, `POST /admin/rooms/upload { dataUrl }`, then save the returned
  `url` in the room's `imageUrl` / `images`.
- Bulk mapping: `GET /admin/rooms/mapping`, edit, `PUT /admin/rooms/mapping`. The PUT **replaces everything**: always
  start from the GET result. Show the returned `warnings`.
- Adapter health: `GET /admin/rooms/mapping/adapters`; "Check now": `POST /admin/rooms/mapping/adapters/{id}/check`.

### Audit log (manager, admin)
- `GET /admin/audit?q=...&action=request.&from=...&to=...`. Room unlocks: `?action=room.unlock`.

### Rules (admin, Release 2)
- `GET /admin/rules`, `POST /admin/rules`, `PATCH /admin/rules/{id}` (`{ isEnabled: false }` to disable),
  `POST /admin/rules/{id}/run`, history `GET /admin/rules/{id}/runs`. Body format: `RuleInput` in the spec.

### Energy (manager, admin, Release 2)
- `GET /admin/energy?groupBy=floor&interval=day&from=...&to=...`: `series[].points` for the chart, `top10` for the table.
- CSV needs the auth header, so download through fetch:

```ts
const res = await fetch(`${API}/admin/energy/export?interval=day`, { headers: { Authorization: `Bearer ${accessToken}` } });
const url = URL.createObjectURL(await res.blob());
Object.assign(document.createElement('a'), { href: url, download: 'energy.csv' }).click();
URL.revokeObjectURL(url);
```

### Front desk (front desk, manager, admin)
- **Today:** `GET /admin/front-desk/today`: `counts`, `arrivals` (`late: true` if overdue), `departures`, `overdueCheckOuts`.
- **Find a room:** `GET /admin/rooms/availability?from=...&to=...&roomType=Suite`.
- **New reservation:** `POST /admin/stays { guest, roomId?, arrival, departure, adults, children, notes }`.
  `guest` is `{ id }` for a returning guest (find with `GET /admin/guests?q=`), or `{ firstName, lastName, email, phone }`.
- **Walk-in:** same call with `checkInNow: true` and `roomId`; the response is a check-in result.
- **Check in:** `POST /admin/stays/{id}/check-in` (add `{ roomId }` if no room yet). Response:
  - `accessCode`: the 8-character booking code, **shown only once**. Display it prominently and print it on the welcome card. It is also emailed to the guest.
  - `qrUrl`: render it as a QR code on the welcome card (e.g. the `qrcode` package). Scanning it signs the guest in.
  - `preferences`: what was applied from a returning guest's saved preferences (`null` if none).
  - `keys[].status`: `active`, or `failed` (give a physical key card and offer "Retry keys").
  - `warnings[]`: show them all.
- **During the stay:** move `POST /admin/stays/{id}/move { roomId, reason }`; change departure
  `POST /admin/stays/{id}/extend { departure }`; new app code `POST /admin/stays/{id}/access-code`;
  retry keys `POST /admin/stays/{id}/keys`.
- **Check out:** `POST /admin/stays/{id}/check-out`. If `keysFailed > 0`, warn that the door key could not be revoked
  (an alert is raised and the system keeps retrying).
- **Reservations:** `POST /admin/stays/{id}/cancel`, `POST /admin/stays/{id}/no-show`.
- **Search:** `GET /admin/stays?q=` (name, email, phone, reference or room), `?inHouse=true`, `?arrivalDate=2026-10-22`.
- **Stay page:** `GET /admin/stays/{id}`: guests, `history`, requests, keys, feedback.
- 409 responses (room occupied, dates overlap, PMS mode) have a clear `message`: show it.
- In PMS booking mode (`booking_mode: "pms"`), hide "New reservation"; check-in and check-out stay available as a fallback.

### Guests
- `GET /admin/guests?q=`, `GET /admin/guests/{id}` (with stay history), `POST`, `PATCH`.
- Admin only: `POST /admin/guests/{id}/anonymise`.

### PMS sync (admin)
- Connections: `GET/POST /admin/pms/connections`, `PATCH /admin/pms/connections/{id}`, secret
  `POST .../secret` (shown once), sync now `POST .../sync`.
- Failed events: `GET /admin/pms/events?status=failed`, retry `POST /admin/pms/events/{id}/retry`.

---

## 6. Guest app (mobile and web)

The guest app uses its own token. Staff tokens don't work on `/guest/*` and guest tokens don't work on `/admin/*`.
The web version has every feature except Bluetooth unlocking: it uses cloud unlock instead.

### Welcome and login
- Before login, `GET /guest/info` (no token) gives the hotel name, reception phone, FAQs, privacy notice and quick links.
- `POST /guest/login` with one of:
  - `{ "bookingCode": "K7Q2MPX4" }`: the code from the welcome card or email. Spaces, dashes and lower case are fine.
  - `{ "qrToken": "..." }`: scan the welcome-card QR. It holds `smartstay://login?token=...`; send the `token` value.
    Register `smartstay://login` as a deep link so the email link opens the app and signs in directly.
  - `{ "reference": "SS7KQ2MP", "lastName": "Obi" }`: fallback for any guest on the booking.
- Response: `{ token, expiresAt }`. Keep the token in secure storage (Keychain / Keystore; on web, memory or sessionStorage).
- Errors to show:

| `code` | Message to show |
|---|---|
| `INVALID_GUEST_CREDENTIALS` | "That code doesn't match a current stay" |
| `NOT_CHECKED_IN` | "You can sign in after check-in" |
| `DEVICE_LIMIT` | The `message`: too many phones signed in for the room; sign out on another phone or ask the front desk |
| `GUEST_ACCESS_LOCKED` | "Too many attempts; try again in 15 minutes or contact the front desk" |

### Session end
Any call can return `401 GUEST_SESSION_ENDED` (checked out, or the front desk reset access). The live channel also
sends `session:ended`. Clear the token and show the login screen. There is no refresh for guest tokens.
`POST /guest/logout` signs out this phone and frees its place.

### Home
`GET /guest/me` returns everything for the home screen:
`room` (number, floor, photo), `stay` (dates, reference), `roomStatus` (`dnd`, `cleaningRequested`),
`key` (`available`, `validUntil`), `eco` (`active`, `since`, `setpoint`) and `quickLinks`.
Show the eco banner when `eco.active` is true (Release 2).

Toggles: `PUT /guest/room-status`:
- `{ "dnd": true }`: also cancels a pending cleaning request.
- `{ "cleaningRequested": true, "note": "after 2pm" }`: also turns DND off, and creates a housekeeping request.
- `{ "cleaningRequested": false }`: cancels it if nobody has started.

### Digital key
- `GET /guest/key` returns `methods` and `keys`. Outside the stay window it returns `403 KEY_NOT_ACTIVE`: show
  "Your key is not active, contact the front desk".
  - `methods.ble`: pass `keys[].credential` to the lock vendor's SDK and unlock over Bluetooth (mobile only).
  - `methods.remote`: `POST /guest/key/unlock` opens the door through the cloud. Use it as the fallback when Bluetooth
    fails, and as the only method on web.
- Unlock errors: `502 UNLOCK_FAILED` ("The door didn't open, try again or contact the front desk"),
  `403 KEY_NOT_ACTIVE`.
- Refresh the key when the app returns to the foreground and after `stay:moved`.

### Controls hub
- `GET /guest/devices` returns `{ eco, devices }`. Each device has `type`, `name`, `online`, `state` and `capabilities`.
  Build the tiles from `type`; build each control from `capabilities`:

| Type | State | Capabilities | Command body |
|---|---|---|---|
| `light` (one per circuit) | `on`, `brightness` | `dimmable` | `{ on }`, `{ brightness: 0-100 }` (dimmable only) |
| `thermostat` | `power`, `mode`, `setpoint`, `fan`, `temperature` | `minTemp`, `maxTemp`, `step`, `modes`, `fanSpeeds` | `{ setpoint }`, `{ mode }`, `{ fan }`, `{ power }` |
| `curtain` | `position` (0 closed, 100 open) | `positionable` | `{ action: "open" \| "close" \| "stop" }` or `{ position }` |
| `tv` | `power`, `volume`, `mute`, `channel`, `input` | `volumeMax`, `inputs`, `channels` | any of `{ power, volume, mute, channel, input }` |
| `speaker` | `power`, `volume`, `playing`, `source` | `volumeMax`, `sources` | any of `{ power, volume, playing, source }` |

- Send with `POST /guest/devices/{id}/command`. The response has the new `device` (replace the tile) and `latencyMs`.
- Keep the AC slider inside `minTemp`..`maxTemp` in `step`s; the API rejects anything else with 400 and field `details`.
- Errors: `409 DEVICE_OFFLINE`, `502 COMMAND_FAILED` (offer retry), `429 RATE_LIMITED` (debounce sliders, e.g. send on release).
- A thermostat with `eco: true` is in eco mode. Any AC change by the guest ends eco for the room.

### Requests
- New: `POST /guest/requests { category, description, preferredAt }`. Categories: housekeeping, amenities, maintenance,
  food, laundry, other. `preferredAt` must be between now and the end of the stay.
- List: `GET /guest/requests`. Detail with timeline: `GET /guest/requests/{id}`. The timeline has `event`
  (created, assigned, in_progress, done, cancelled), `by` (you or hotel) and `at`; staff names are never included.
- Cancel: `POST /guest/requests/{id}/cancel`, offered when `canCancel` is true. Too late gives `409` with a message.

### Feedback
Send `multipart/form-data`:

```ts
const form = new FormData();
form.append('rating', '4');
form.append('comment', 'Shower drips');
form.append('markAsIssue', 'true');            // also creates a staff alert
for (const photo of photos.slice(0, 3)) form.append('photos', photo); // JPEG, PNG, WebP or HEIC, 5 MB each
await fetch(`${API}/guest/feedback`, { method: 'POST', headers: { Authorization: `Bearer ${guestToken}` }, body: form });
```

JSON (`{ "rating": 5, "comment": "Great" }`) works too when there are no photos.

### Preferences (Release 2)
- `GET /guest/preferences`, `PUT /guest/preferences { preferences, applyNow }`.
- `preferences`: `{ lights: { on, brightness }, temperature: { setpoint, mode, fan }, music: { source, volume, autoplay } }`.
- Saved preferences are applied automatically at the guest's next check-in. `applyNow: true` applies them straight away;
  the response's `applied.skipped` lists what the room can't do (for example no speaker).

### Push notifications
After login: `PUT /guest/push-token { pushToken, platform }` with the FCM token. Request status changes arrive as
pushes with `data.type = "request_status"`.

### Live updates
```ts
const socket = io(`${API}/guest`, { auth: { token: guestToken }, transports: ['websocket'] });
socket.on('device:state', (device) => controls.replace(device));     // same shape as GET /guest/devices items
socket.on('room:status', (s) => home.setStatus(s));                  // { dnd, cleaningRequested, cleaningRequestedAt, eco }
socket.on('request:updated', (r) => requests.replace(r));           // same shape as GET /guest/requests items
socket.on('stay:moved', () => reloadMeDevicesAndKey());              // the guest was moved to another room
socket.on('session:ended', () => signOutLocally());                  // checked out or access reset
```

Only the guest's own stay receives these events.

---

## 7. Staff-side changes from the guest app

- Board rooms and room detail have `cleaningRequested` and `cleaningRequestedAt`; the request itself is a normal
  housekeeping request in the queue (cleared automatically when it is done or cancelled).
- Requests have `preferredAt`; show it on the queue card.
- Feedback has `isIssue`; uploaded photo `url`s are signed links valid for an hour. Prefix with the API origin and use
  them directly in `<img src>`; reload the list for fresh links.
- Hotel settings (admin) add `reception_phone`, `guest_faqs`, `privacy_notice`, `guest_quick_links`,
  `guest_app_login_url`, `guest_commands_per_minute`, `apply_guest_preferences_on_check_in`.
  `phones_per_room` limits how many phones can sign in per stay (0 = no limit).
- Rooms and devices: devices can be `tv` or `speaker`, and take an optional `capabilities` object
  (for example `{ "dimmable": true }` or `{ "inputs": ["tv", "hdmi1"] }`).
- New guest code from the front desk: `POST /admin/stays/{id}/access-code { signOutDevices, email }` returns
  `accessCode`, `qrToken` and `qrUrl`.
