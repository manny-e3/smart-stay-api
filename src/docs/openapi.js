/**
 * OpenAPI 3.1 description of the SmartStay API, served at /docs (Swagger UI) and /docs/openapi.json.
 * tests/openapi.test.js checks that every operation here exists in the app.
 */
import { PERMISSIONS } from '../core/permissions.js';

/* ------------------------------------------------------------ helpers */

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const int = (extra = {}) => ({ type: 'integer', ...extra });
const num = (extra = {}) => ({ type: 'number', ...extra });
const bool = (extra = {}) => ({ type: 'boolean', ...extra });
const dt = (extra = {}) => ({ type: 'string', format: 'date-time', ...extra });
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
const nul = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const enm = (values, extra = {}) => ({ type: 'string', enum: values, ...extra });
const anyObj = (description) => ({ type: 'object', additionalProperties: true, ...(description ? { description } : {}) });
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, ...(required.length ? { required } : {}) });
/** Object whose fields are all optional (request bodies for PATCH, filters). */
const opt = (properties) => ({ type: 'object', properties });

const page = (item) =>
  obj({ items: arr(item), page: int(), limit: int(), total: int({ description: 'Total matching rows across all pages' }) });

const ROLES = ['service', 'maintenance', 'front_desk', 'manager', 'admin'];
const REQUEST_STATUSES = ['new', 'assigned', 'in_progress', 'done', 'cancelled'];
const REQUEST_CATEGORIES = ['housekeeping', 'amenities', 'maintenance', 'food', 'laundry', 'other'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const ROOM_STATUSES = ['alert', 'request', 'dnd', 'occupied', 'vacant'];
const STAY_STATUSES = ['reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show'];
const DEVICE_TYPES = ['lock', 'thermostat', 'light', 'curtain', 'sensor', 'meter', 'phone', 'tv', 'speaker', 'other'];
const ALERT_TYPES = ['device_offline', 'device_fault', 'low_battery', 'adapter_down', 'guest_issue', 'command_failed', 'key_failed', 'key_revoke_failed', 'pms_sync_failed'];
const DEVICE_EVENTS = ['status', 'online', 'offline', 'fault', 'low_battery', 'unlock', 'dnd_on', 'dnd_off', 'presence'];
const PMS_EVENTS = ['reservation.upsert', 'reservation.cancelled', 'reservation.no_show', 'stay.checked_in', 'stay.checked_out', 'stay.room_moved'];

const q = (name, schema, description, required = false) => ({ name, in: 'query', required, schema, ...(description ? { description } : {}) });
const pathId = (name = 'id', description) => ({ name, in: 'path', required: true, schema: int({ minimum: 1 }), ...(description ? { description } : {}) });
const pageParams = [q('page', int({ minimum: 1, default: 1 })), q('limit', int({ minimum: 1, maximum: 200, default: 25 }))];
const csv = (values, description) => str({ description: `${description ?? 'Comma-separated'}: ${values.join(', ')}` });

const ERR = {
  400: { description: 'Validation failed or the action is not allowed in the current state', content: { 'application/json': { schema: ref('Error') } } },
  401: { description: 'Missing, invalid or expired token', content: { 'application/json': { schema: ref('Error') } } },
  403: { description: 'Your role is not allowed to do this', content: { 'application/json': { schema: ref('Error') } } },
  404: { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } },
  409: { description: 'Conflicts with existing data (duplicate, room occupied, overlapping booking)', content: { 'application/json': { schema: ref('Error') } } },
  423: { description: 'Locked after too many failed attempts', content: { 'application/json': { schema: ref('Error') } } },
  429: { description: 'Rate limited', content: { 'application/json': { schema: ref('Error') } } },
};

const paths = {};

/**
 * Registers one operation.
 * auth: 'staff' (default) | 'guest' | 'none' | 'adapter' | 'pms'
 * perm: permission key from src/core/permissions.js; its roles are listed in the description.
 */
function op(method, path, { tag, summary, description = '', perm, auth = 'staff', params = [], body, bodyRequired = true, data, status = 200, errors = [], raw }) {
  const roles = perm ? PERMISSIONS[perm] : null;
  const notes = [description, roles ? `**Roles:** ${roles.join(', ')}` : ''].filter(Boolean).join('\n\n');
  const security = { staff: [{ staffBearer: [] }], guest: [{ guestBearer: [] }], none: [], adapter: [{ adapterSecret: [] }], pms: [{ pmsSecret: [] }] }[auth];
  const responses = {
    [status]: raw ?? {
      description: 'Success',
      content: { 'application/json': { schema: obj({ success: { const: true }, ...(data ? { data } : {}) }, data ? ['success', 'data'] : ['success']) } },
    },
  };
  const errorCodes = new Set([...(auth === 'staff' || auth === 'guest' || auth === 'adapter' || auth === 'pms' ? [401] : []), ...(perm ? [403] : []), ...errors, ...(body || params.length ? [400] : [])]);
  for (const code of [...errorCodes].sort()) responses[code] = ERR[code];
  paths[path] ??= {};
  paths[path][method] = {
    tags: [tag],
    summary,
    ...(notes ? { description: notes } : {}),
    operationId: `${method}${path.replace(/[{}]/g, '').replace(/[/\-.](\w)/g, (_, c) => c.toUpperCase())}`,
    security,
    ...(params.length ? { parameters: params } : {}),
    ...(body ? { requestBody: { required: bodyRequired, content: { 'application/json': { schema: body } } } } : {}),
    responses,
    ...(roles ? { 'x-roles': roles } : {}),
  };
}

/* ------------------------------------------------------------ schemas */

const roomRef = obj({ id: int(), number: str(), floor: int() });
const personRef = obj({ id: int(), name: str() });

const schemas = {
  Error: obj(
    {
      success: { const: false },
      code: str({ description: 'Machine-readable code, e.g. BAD_REQUEST, UNAUTHORIZED, TOKEN_EXPIRED, SESSION_INVALID, OTP_REQUIRED, FORBIDDEN, NOT_FOUND, CONFLICT, ACCOUNT_LOCKED, RATE_LIMITED' }),
      message: str({ description: 'Human-readable message, safe to show to staff' }),
      details: arr(obj({ field: str({ example: 'body.email' }), message: str() }), { description: 'Present on validation errors (400)' }),
    },
    ['success', 'code', 'message'],
  ),

  Staff: obj({ id: int(), name: str(), email: str({ format: 'email' }), role: enm(ROLES), isActive: bool(), otpEnabled: bool(), lastLoginAt: nul(dt()), createdAt: dt() }),
  Tokens: obj({
    accessToken: str({ description: 'Send as "Authorization: Bearer <token>". Valid for expiresIn seconds.' }),
    expiresIn: int({ example: 900 }),
    refreshToken: str({ description: 'Also set as httpOnly cookie ss_refresh (path /staff). Use with POST /staff/refresh.' }),
    staff: ref('Staff'),
  }),

  RoomSummary: obj({
    id: int(),
    number: str({ example: '101' }),
    floor: obj({ id: int(), number: int(), name: nul(str()) }),
    roomType: nul(obj({ id: int(), name: str() })),
    imageUrl: nul(str({ description: 'Main photo, e.g. /uploads/room-....jpg (prefix with the API origin)' })),
    images: arr(str()),
    status: enm(ROOM_STATUSES, { description: 'First that applies: alert > request > dnd > occupied > vacant' }),
    priority: int({ description: 'Index of status in that order (0 = most urgent)' }),
    occupied: bool(),
    dnd: bool(),
    cleaningRequested: bool(),
    cleaningRequestedAt: nul(dt()),
    guest: nul(obj({ stayId: int(), name: str(), checkOutAt: dt() })),
    arrivalToday: bool(),
    departureToday: bool(),
    checkOutOverdue: bool(),
    openRequests: int(),
    escalatedRequests: int(),
    oldestRequestAt: nul(dt()),
    openAlerts: int(),
    alertSeverity: nul(enm(['info', 'warning', 'critical'])),
    devicesOffline: int(),
  }),
  Board: obj({
    counts: obj({ alert: int(), request: int(), dnd: int(), occupied: int(), vacant: int(), total: int() }),
    statuses: arr(enm(ROOM_STATUSES)),
    floors: arr(obj({ id: int(), number: int(), name: nul(str()), rooms: arr(ref('RoomSummary')) })),
    generatedAt: dt(),
  }),
  RoomDetail: {
    allOf: [
      ref('RoomSummary'),
      obj({
        stay: nul(
          obj(
            {
              id: int(),
              reference: str({ description: 'Only for front desk, manager, admin' }),
              checkInAt: dt(),
              checkOutAt: dt(),
              checkedInAt: nul(dt()),
              adults: int(),
              children: int(),
              guest: obj(
                { id: int(), firstName: str(), lastName: nul(str()), phone: nul(str()), email: nul(str()), language: nul(str()), vip: bool() },
                ['id', 'firstName', 'vip'],
              ),
            },
            ['id', 'checkInAt', 'checkOutAt', 'guest'],
          ),
          { description: 'Guest lastName, phone, email and reference are only returned to roles with stays:read' },
        ),
        requests: arr(obj({ id: int(), category: str(), description: nul(str()), priority: str(), status: str(), createdAt: dt(), escalated: bool(), assignee: nul(personRef) })),
        alerts: arr(obj({ id: int(), type: str(), severity: str(), title: str(), message: nul(str()), occurrenceCount: int(), lastSeenAt: dt(), deviceName: nul(str()) })),
        devices: arr(obj({ id: int(), type: enm(DEVICE_TYPES), name: nul(str()), externalId: str(), adapter: str(), adapterStatus: str(), online: nul(bool()), state: anyObj('Last reported device state, e.g. { mode, setpoint }'), lastSeenAt: nul(dt()) })),
        recentFeedback: arr(obj({ id: int(), rating: int(), comment: nul(str()), createdAt: dt() })),
      }),
    ],
  },
  Room: obj({ id: int(), number: str(), floor: int(), roomType: nul(str()), isActive: bool(), imageUrl: nul(str()), images: arr(str()) }, ['id', 'number']),

  Request: obj({
    id: int(),
    category: enm(REQUEST_CATEGORIES),
    description: nul(str()),
    priority: enm(PRIORITIES),
    status: enm(REQUEST_STATUSES),
    source: enm(['guest', 'staff']),
    room: roomRef,
    guest: nul(personRef),
    stayId: nul(int()),
    assignee: nul(personRef),
    createdBy: nul(personRef),
    escalated: bool(),
    escalatedAt: nul(dt()),
    completedAt: nul(dt()),
    preferredAt: nul(dt({ description: 'When the guest would like it done' })),
    createdAt: dt(),
    updatedAt: dt(),
  }),
  RequestDetail: {
    allOf: [
      ref('Request'),
      obj({
        history: arr(
          obj({
            id: int(),
            action: str({ description: 'created, assigned, unassigned, status_changed, priority_changed, note, escalated, room_moved' }),
            fromStatus: nul(str()),
            toStatus: nul(str()),
            note: nul(str()),
            data: nul(anyObj()),
            actor: obj({ type: enm(['staff', 'guest', 'system']), id: int(), name: str() }, ['type']),
            at: dt(),
          }),
        ),
      }),
    ],
  },

  Alert: obj({
    id: int(),
    type: enm(ALERT_TYPES),
    severity: enm(['info', 'warning', 'critical']),
    source: enm(['device', 'guest', 'system']),
    status: enm(['open', 'resolved']),
    title: str(),
    message: nul(str()),
    occurrenceCount: int({ description: 'Duplicates are grouped into one alert' }),
    firstSeenAt: dt(),
    lastSeenAt: dt(),
    room: nul(roomRef),
    device: nul(obj({ id: int(), name: nul(str()), type: str(), externalId: str() })),
    adapter: nul(obj({ id: int(), name: str() })),
    feedbackId: nul(int()),
    resolvedAt: nul(dt()),
    resolvedBy: nul(personRef),
    resolutionNote: nul(str()),
  }),
  AlertDetail: {
    allOf: [
      ref('Alert'),
      obj({
        occurrences: arr(obj({ id: int(), occurredAt: dt(), payload: nul(anyObj()) })),
        deviceHistory: arr(obj({ id: int(), type: enm(DEVICE_EVENTS), payload: nul(anyObj()), occurredAt: dt() })),
        deviceState: nul(obj({ online: bool(), state: anyObj(), lastSeenAt: nul(dt()) })),
      }),
    ],
  },

  Feedback: obj({
    id: int(),
    rating: int({ minimum: 1, maximum: 5 }),
    category: nul(str()),
    comment: nul(str()),
    room: roomRef,
    guest: nul(personRef),
    stayId: nul(int()),
    isIssue: bool({ description: 'Guest marked it as an issue (also in the alert list)' }),
    photos: arr(obj({ id: int(), url: str({ description: 'Signed link, valid for an hour; use directly in <img src> with the API origin' }) })),
    createdAt: dt(),
  }),

  Settings: obj({
    hotel_name: str(),
    ac_min_temp: num(),
    ac_max_temp: num(),
    eco_enabled: bool(),
    eco_delay_minutes: int(),
    eco_setpoint: num(),
    escalation_minutes: int(),
    phones_per_room: int(),
    low_rating_threshold: int({ minimum: 1, maximum: 5 }),
    alert_email_recipients: arr(str({ format: 'email' })),
    timezone: str({ example: 'Africa/Lagos' }),
    booking_mode: enm(['manual', 'pms']),
    no_show_after_hours: int({ description: '0 = off' }),
    checkout_grace_minutes: int(),
    close_requests_on_checkout: bool(),
    email_access_code_to_guest: bool(),
    guest_data_retention_days: int({ description: '0 = keep forever' }),
    reception_phone: str(),
    guest_faqs: arr(obj({ question: str(), answer: str() })),
    privacy_notice: str(),
    guest_quick_links: arr(ref('QuickLink')),
    guest_app_login_url: str({ example: 'smartstay://login', description: 'Base of the QR login link' }),
    guest_commands_per_minute: int(),
    apply_guest_preferences_on_check_in: bool(),
  }),

  Adapter: obj({
    id: int(),
    name: str(),
    vendor: str({ example: 'mock' }),
    isEnabled: bool(),
    config: anyObj('Credentials are returned as "********"; sending that value back keeps the stored one'),
    hasWebhookSecret: bool(),
    health: obj({ status: enm(['unknown', 'healthy', 'degraded', 'down']), consecutiveFailures: int(), lastSuccessAt: nul(dt()), lastErrorAt: nul(dt()), lastError: nul(str()), latencyMs: nul(int()) }),
  }),
  MappingDevice: obj({ adapter: str({ description: 'Adapter name' }), externalId: str({ description: "Device id in the client's system" }), type: enm(DEVICE_TYPES), name: str(), capabilities: nul(anyObj('Guest app capabilities, e.g. { dimmable: true }; omit to keep current')) }, ['adapter', 'externalId', 'type']),
  Mapping: obj({
    floors: arr(obj({ id: int(), number: int(), name: nul(str()) })),
    roomTypes: arr(str()),
    adapters: arr(ref('Adapter')),
    rooms: arr(obj({ id: int(), number: str(), floor: int(), roomType: nul(str()), isActive: bool(), devices: arr({ allOf: [ref('MappingDevice'), obj({ id: int() })] }) })),
    unassignedDevices: arr(ref('MappingDevice')),
  }),

  AuditEntry: obj({
    id: int(),
    action: str({ example: 'request.update' }),
    actor: obj({ type: enm(['staff', 'guest', 'system']), id: int(), name: str(), email: str() }, ['type']),
    entityType: str(),
    entityId: nul(str()),
    room: nul(obj({ id: int(), number: str() })),
    details: nul(anyObj()),
    ip: nul(str()),
    at: dt(),
  }),

  RuleInput: obj(
    {
      name: str({ minLength: 2 }),
      type: enm(['schedule', 'vacancy']),
      isEnabled: bool({ default: true }),
      cron: str({ description: 'Required for schedule rules, in UTC. Example "0 23 * * *"' }),
      target: {
        oneOf: [
          obj({ scope: { const: 'all' } }),
          obj({ scope: { const: 'floors' }, floors: arr(int()) }),
          obj({ scope: { const: 'rooms' }, roomIds: arr(int()) }),
          obj({ scope: { const: 'roomTypes' }, roomTypes: arr(str()) }),
        ],
      },
      conditions: opt({
        occupancy: enm(['any', 'vacant', 'occupied'], { description: 'Schedule rules' }),
        trigger: enm(['unsold', 'no_presence'], { description: 'Vacancy rules (required)' }),
        delayMinutes: int({ description: 'Vacancy rules; defaults to the eco delay setting' }),
      }),
      actions: arr({
        oneOf: [
          obj({ type: { const: 'set_climate' }, mode: enm(['eco', 'cool', 'heat', 'auto', 'off']), setpoint: num() }, ['type', 'mode']),
          obj({ type: { const: 'lights' }, on: bool() }),
          obj({ type: { const: 'curtains' }, open: bool() }),
        ],
      }),
    },
    ['name', 'type', 'target', 'actions'],
  ),
  Rule: obj({
    id: int(),
    name: str(),
    type: enm(['schedule', 'vacancy']),
    isEnabled: bool(),
    cron: nul(str()),
    target: anyObj(),
    conditions: anyObj(),
    actions: arr(anyObj()),
    lastRunAt: nul(dt()),
    lastRunStatus: nul(str()),
    nextRunAt: nul(dt()),
    createdBy: nul(int()),
    createdAt: dt(),
    updatedAt: dt(),
  }),
  RuleRun: obj({
    id: int(),
    trigger: enm(['schedule', 'vacancy', 'manual']),
    status: enm(['running', 'success', 'partial', 'failed', 'skipped']),
    roomsMatched: int(),
    commandsSent: int(),
    commandsFailed: int(),
    details: nul(anyObj()),
    triggeredBy: nul(int()),
    startedAt: dt(),
    finishedAt: nul(dt()),
  }),

  Energy: obj({
    from: dt(),
    to: dt(),
    groupBy: enm(['room', 'floor']),
    interval: enm(['hour', 'day', 'month']),
    totalKwh: num(),
    series: arr(obj({ id: int(), label: str({ example: 'Room 101' }), floor: int(), total: num(), points: arr(obj({ period: str({ example: '2026-10-21' }), kwh: num() })) }, ['id', 'label', 'total', 'points'])),
    top10: arr(obj({ roomId: int(), number: str(), floor: int(), kwh: num() })),
  }),

  GuestInput: obj(
    { firstName: str(), lastName: str(), email: str({ format: 'email' }), phone: str(), language: str({ example: 'en' }), vip: bool() },
    ['firstName'],
  ),
  Stay: obj({
    id: int(),
    reference: str({ example: 'SS7KQ2MP' }),
    status: enm(STAY_STATUSES),
    source: enm(['manual', 'pms']),
    externalId: nul(str({ description: 'PMS reservation id' })),
    room: nul(roomRef),
    roomType: nul(str()),
    guest: obj({ id: int(), firstName: str(), lastName: nul(str()), email: nul(str()), phone: nul(str()), language: nul(str()), vip: bool() }),
    arrival: dt({ description: 'Planned arrival' }),
    departure: dt({ description: 'Planned departure' }),
    checkedInAt: nul(dt()),
    checkedOutAt: nul(dt()),
    adults: int(),
    children: int(),
    notes: nul(str()),
    createdAt: dt(),
    updatedAt: dt(),
  }),
  DigitalKey: obj({
    id: int(),
    deviceId: int(),
    roomId: int(),
    status: enm(['active', 'revoked', 'failed', 'revoke_failed']),
    validFrom: dt(),
    validUntil: dt(),
    lastError: nul(str()),
    issuedAt: dt(),
    revokedAt: nul(dt()),
  }),
  StayDetail: {
    allOf: [
      ref('Stay'),
      obj({
        guests: arr(obj({ id: int(), firstName: str(), lastName: nul(str()), email: nul(str()), phone: nul(str()), isPrimary: bool() })),
        history: arr(
          obj({
            id: int(),
            action: str({ description: 'created, updated, checked_in, moved, extended, shortened, checked_out, cancelled, no_show, access_code_issued, keys_reissued' }),
            actor: obj({ type: enm(['staff', 'guest', 'system', 'pms']), id: int(), name: str() }, ['type']),
            fromRoom: nul(str()),
            toRoom: nul(str()),
            note: nul(str()),
            data: nul(anyObj('manualOverride: true when staff changed a PMS-managed stay')),
            at: dt(),
          }),
        ),
        requests: arr(obj({ id: int(), category: str(), status: str(), roomId: int(), createdAt: dt() })),
        keys: arr(ref('DigitalKey')),
        feedback: arr(obj({ id: int(), rating: int(), comment: nul(str()), createdAt: dt() })),
      }),
    ],
  },
  CheckInResult: obj({
    stay: ref('StayDetail'),
    accessCode: str({ example: 'K7Q2MPX4', description: 'Guest booking code for the app. Shown ONCE: display or print it now (it is also emailed).' }),
    qrToken: str({ description: 'Shown once. Encoded in qrUrl.' }),
    qrUrl: str({ example: 'smartstay://login?token=...', description: 'Render as a QR code on the welcome card' }),
    keys: arr(ref('DigitalKey')),
    warnings: arr(str(), { description: 'Show these to the receptionist, e.g. key could not be issued, open critical alert in room' }),
    preferences: nul(ref('PreferencesApplied')),
  }),
  Guest: obj({
    id: int(),
    firstName: str(),
    lastName: nul(str()),
    email: nul(str()),
    phone: nul(str()),
    language: nul(str()),
    vip: bool(),
    notes: nul(str()),
    externalId: nul(str()),
    anonymized: bool(),
    anonymizedAt: nul(dt()),
    createdAt: dt(),
  }),
  FrontDeskToday: obj({
    date: dt({ description: 'Start of the hotel-local day, in UTC' }),
    timezone: str(),
    counts: obj({ arrivals: int(), departures: int(), overdueCheckOuts: int(), inHouse: int(), vacantRooms: int(), totalRooms: int() }),
    arrivals: arr({ allOf: [ref('Stay'), obj({ late: bool({ description: 'Was due before today' }) })] }),
    departures: arr(ref('Stay')),
    overdueCheckOuts: arr(ref('Stay')),
  }),
  Availability: obj({
    from: dt(),
    to: dt(),
    total: int(),
    byRoomType: { type: 'object', additionalProperties: int(), example: { Standard: 4, Suite: 1 } },
    rooms: arr(obj({ id: int(), number: str(), floor: int(), roomType: nul(str()) })),
  }),

  GuestSession: obj({ token: str({ description: 'Guest token for the guest app ("Authorization: Bearer"). Not valid on staff endpoints.' }), expiresAt: dt() }),
  QuickLink: obj({ label: str(), url: str(), icon: str() }, ['label', 'url']),
  RoomStatus: obj({ dnd: bool(), cleaningRequested: bool(), cleaningRequestedAt: nul(dt()) }),
  EcoState: obj({ active: bool(), since: nul(dt()), setpoint: nul(num()) }),
  GuestMe: obj({
    hotel: obj({ name: str(), receptionPhone: nul(str()), acMinTemp: num(), acMaxTemp: num() }),
    guest: obj({ firstName: str(), lastName: nul(str()), language: nul(str()) }),
    stay: obj({ reference: str(), arrival: dt(), departure: dt(), checkedInAt: nul(dt()), adults: int(), children: int() }),
    room: obj({ number: str(), floor: int(), roomType: nul(str()), imageUrl: nul(str()) }),
    roomStatus: ref('RoomStatus'),
    key: obj({ available: bool(), validUntil: nul(dt()) }),
    eco: ref('EcoState'),
    quickLinks: arr(ref('QuickLink')),
  }),
  GuestKeyInfo: obj({
    methods: obj({ ble: bool(), remote: bool() }),
    validFrom: dt(),
    validUntil: dt(),
    keys: arr({ allOf: [ref('DigitalKey'), obj({ doorName: str(), credential: nul(anyObj("Vendor credential for the lock's mobile SDK (Bluetooth)")), remoteUnlock: bool() })] }),
  }),
  GuestDevice: obj({
    id: int(),
    type: enm(['light', 'thermostat', 'curtain', 'tv', 'speaker']),
    name: str({ example: 'Bedside' }),
    online: bool(),
    state: anyObj('light: on, brightness | thermostat: power, mode, setpoint, fan, temperature | curtain: position | tv: power, volume, mute, channel, input | speaker: power, volume, playing, source'),
    eco: bool({ description: 'Thermostats only' }),
    capabilities: anyObj('light: dimmable | thermostat: modes, fanSpeeds, step, minTemp, maxTemp | curtain: positionable | tv: volumeMax, inputs, channels | speaker: volumeMax, sources'),
    lastSeenAt: nul(dt()),
  }, ['id', 'type', 'name', 'online', 'state', 'capabilities']),
  LightCommand: opt({ on: bool(), brightness: int({ minimum: 0, maximum: 100 }) }),
  ThermostatCommand: opt({ power: bool(), setpoint: num({ example: 22.5 }), mode: enm(['cool', 'heat', 'auto', 'fan']), fan: enm(['auto', 'low', 'medium', 'high']) }),
  CurtainCommand: opt({ action: enm(['open', 'close', 'stop']), position: int({ minimum: 0, maximum: 100 }) }),
  TvCommand: opt({ power: bool(), volume: int({ minimum: 0 }), mute: bool(), channel: int({ minimum: 1 }), input: str({ example: 'hdmi1' }) }),
  SpeakerCommand: opt({ power: bool(), volume: int({ minimum: 0 }), playing: bool(), source: str() }),
  GuestRequest: obj({
    id: int(),
    category: enm(REQUEST_CATEGORIES),
    description: nul(str()),
    priority: enm(PRIORITIES),
    status: enm(REQUEST_STATUSES),
    preferredAt: nul(dt()),
    room: obj({ number: str() }),
    canCancel: bool(),
    createdAt: dt(),
    updatedAt: dt(),
    completedAt: nul(dt()),
  }),
  GuestRequestDetail: {
    allOf: [ref('GuestRequest'), obj({ timeline: arr(obj({ event: enm(['created', 'assigned', 'in_progress', 'done', 'cancelled']), by: enm(['you', 'hotel']), at: dt() })) })],
  },
  Preferences: opt({
    lights: opt({ on: bool(), brightness: int({ minimum: 0, maximum: 100 }) }),
    temperature: obj({ setpoint: num(), mode: enm(['cool', 'heat', 'auto', 'fan']), fan: enm(['auto', 'low', 'medium', 'high']) }, ['setpoint']),
    music: opt({ source: str(), volume: int({ minimum: 0, maximum: 100 }), autoplay: bool() }),
  }),
  PreferencesApplied: obj({ applied: int(), failed: int(), skipped: arr(str()) }),

  PmsConnection: obj({
    id: int(),
    name: str(),
    vendor: enm(['http', 'mock']),
    isEnabled: bool(),
    config: anyObj('Credentials returned as "********"'),
    hasWebhookSecret: bool(),
    status: enm(['unknown', 'healthy', 'degraded', 'down']),
    lastSyncAt: nul(dt()),
    lastSyncResult: nul(str()),
    lastError: nul(str()),
    lastErrorAt: nul(dt()),
    webhookUrl: str(),
  }),
  PmsReservation: obj(
    {
      externalId: str(),
      reference: str(),
      status: enm(STAY_STATUSES),
      roomCode: str({ description: 'Matched to rooms.pms_code, then room number' }),
      roomType: str(),
      arrival: dt(),
      departure: dt(),
      adults: int(),
      children: int(),
      notes: str(),
      guest: obj({ externalId: str(), firstName: str(), lastName: str(), email: str(), phone: str(), language: str() }, ['firstName']),
      companions: arr(anyObj()),
    },
    ['externalId', 'arrival', 'departure', 'guest'],
  ),
  PmsEvent: obj({
    id: int(),
    connectionId: int(),
    eventId: str(),
    type: enm(PMS_EVENTS),
    status: enm(['pending', 'processed', 'ignored', 'failed']),
    result: nul(str()),
    payload: anyObj(),
    occurredAt: nul(dt()),
    receivedAt: dt(),
    processedAt: nul(dt()),
  }),
};

/* --------------------------------------------------------- operations */

// Health
op('get', '/health', { tag: 'Health', summary: 'API health', auth: 'none', data: undefined, raw: { description: 'OK', content: { 'application/json': { schema: obj({ success: { const: true }, status: str(), uptime: num() }) } } } });
op('get', '/health/db', { tag: 'Health', summary: 'Database health', auth: 'none', raw: { description: 'OK', content: { 'application/json': { schema: obj({ success: { const: true }, database: str() }) } } } });

// Staff auth
op('post', '/staff/login', {
  tag: 'Staff auth',
  summary: 'Sign in',
  auth: 'none',
  description:
    'Returns tokens and sets the refresh cookie. If the account has the one-time code switched on and `otp` is missing, the API answers 401 with code `OTP_REQUIRED`: show the code field and call again with `otp`. 423 `ACCOUNT_LOCKED` after 5 failed attempts.',
  body: obj({ email: str({ format: 'email' }), password: str(), otp: str({ pattern: '^\\d{6}$' }) }, ['email', 'password']),
  data: ref('Tokens'),
  errors: [423, 429],
});
op('post', '/staff/refresh', {
  tag: 'Staff auth',
  summary: 'Get new tokens',
  auth: 'none',
  description: 'Uses the ss_refresh cookie (send with credentials) or `refreshToken` in the body. The old refresh token stops working; reusing it signs the account out everywhere.',
  body: opt({ refreshToken: str() }),
  bodyRequired: false,
  data: ref('Tokens'),
  errors: [401],
});
op('post', '/staff/logout', { tag: 'Staff auth', summary: 'Sign out', auth: 'none', description: 'Send the access token header if you have it; the session ends either way.', body: opt({ refreshToken: str() }), bodyRequired: false });
op('get', '/staff/me', { tag: 'Staff auth', summary: 'My profile', data: ref('Staff') });
op('post', '/staff/me/password', { tag: 'Staff auth', summary: 'Change my password', description: 'New password: 10+ characters with a letter and a number. Other sessions are signed out.', body: obj({ currentPassword: str(), newPassword: str() }) });
op('post', '/staff/me/otp/setup', { tag: 'Staff auth', summary: 'Start one-time code setup', description: 'Show `otpauthUrl` as a QR code for an authenticator app, then call enable with a code from the app.', data: obj({ secret: str(), otpauthUrl: str() }) });
op('post', '/staff/me/otp/enable', { tag: 'Staff auth', summary: 'Turn on one-time code', body: obj({ code: str({ pattern: '^\\d{6}$' }) }) });
op('post', '/staff/me/otp/disable', { tag: 'Staff auth', summary: 'Turn off one-time code', body: obj({ code: str({ pattern: '^\\d{6}$' }) }) });
op('get', '/staff/push/public-key', { tag: 'Staff auth', summary: 'Browser push public key', auth: 'none', description: 'VAPID key for PushManager.subscribe({ applicationServerKey }).', data: obj({ publicKey: nul(str()) }) });
op('post', '/staff/me/push-subscriptions', { tag: 'Staff auth', summary: 'Save browser push subscription', description: 'Send PushSubscription.toJSON().', body: obj({ endpoint: str({ format: 'uri' }), keys: obj({ p256dh: str(), auth: str() }) }), status: 201 });
op('delete', '/staff/me/push-subscriptions', { tag: 'Staff auth', summary: 'Remove browser push subscription', body: obj({ endpoint: str() }) });

// Room board and rooms
op('get', '/admin/rooms/board', {
  tag: 'Room board',
  summary: 'Room board',
  perm: 'board:read',
  description: 'Rooms grouped by floor, most urgent first. Keep it live with the `board:room` and `board:refresh` socket events.',
  params: [q('floor', str({ description: 'Comma-separated floor numbers' })), q('status', csv(ROOM_STATUSES)), q('roomType', str({ description: 'Comma-separated room type names' }))],
  data: ref('Board'),
});
op('get', '/admin/rooms/{id}', { tag: 'Room board', summary: 'Room detail panel', perm: 'board:read', params: [pathId()], data: ref('RoomDetail'), errors: [404] });
op('post', '/admin/rooms', {
  tag: 'Rooms and devices',
  summary: 'Create a room',
  perm: 'mapping:manage',
  description: 'Creates the floor and room type if they do not exist. Re-creating a deactivated room number reactivates it.',
  body: obj({ number: str(), floor: int(), roomType: str(), isActive: bool(), imageUrl: str(), images: arr(str()) }, ['number', 'floor']),
  data: ref('Room'),
  status: 201,
  errors: [409],
});
op('patch', '/admin/rooms/{id}', {
  tag: 'Rooms and devices',
  summary: 'Edit a room',
  perm: 'mapping:manage',
  params: [pathId()],
  body: opt({ number: str(), floor: int(), roomType: nul(str()), isActive: bool(), dnd: bool(), imageUrl: nul(str()), images: nul(arr(str())) }),
  data: ref('Room'),
  errors: [404, 409],
});
op('delete', '/admin/rooms/{id}', {
  tag: 'Rooms and devices',
  summary: 'Delete a room',
  perm: 'mapping:manage',
  description: 'Rooms with history are deactivated instead of deleted (`softDeleted: true`). Not allowed while a guest is checked in.',
  params: [pathId()],
  data: obj({ id: int(), number: str(), softDeleted: bool(), success: bool() }),
  errors: [404],
});
op('post', '/admin/rooms/upload', {
  tag: 'Rooms and devices',
  summary: 'Upload a room photo',
  perm: 'mapping:manage',
  description: 'Send the image as a base64 data URL (FileReader.readAsDataURL). Use the returned `url` in imageUrl/images. Images are served from the API origin at /uploads.',
  body: obj({ dataUrl: str({ example: 'data:image/jpeg;base64,/9j/4AAQ...' }) }),
  data: obj({ url: str({ example: '/uploads/room-1761130000000-ab12cd34.jpg' }), filename: str(), sizeBytes: int() }),
});
op('get', '/admin/rooms/mapping', { tag: 'Rooms and devices', summary: 'Room, floor and device mapping', perm: 'mapping:manage', data: ref('Mapping') });
op('put', '/admin/rooms/mapping', {
  tag: 'Rooms and devices',
  summary: 'Replace the whole mapping',
  perm: 'mapping:manage',
  description: '**Replaces everything.** Rooms and devices left out are deactivated. Load GET mapping, edit it, send it back.',
  body: obj(
    {
      floors: arr(obj({ number: int(), name: str() }, ['number'])),
      roomTypes: arr(str()),
      adapters: arr(obj({ name: str(), vendor: str(), isEnabled: bool(), config: anyObj() }, ['name', 'vendor'])),
      rooms: arr(obj({ number: str(), floor: int(), roomType: str(), isActive: bool(), devices: arr(ref('MappingDevice')) }, ['number', 'floor'])),
    },
    ['floors', 'rooms'],
  ),
  data: obj({ summary: obj({ floors: int(), rooms: int(), devices: int(), roomsDeactivated: int(), devicesDeactivated: int() }), warnings: arr(str()), mapping: ref('Mapping') }),
});
op('get', '/admin/rooms/mapping/adapters', { tag: 'Rooms and devices', summary: 'Device adapters and their health', perm: 'mapping:manage', data: arr(ref('Adapter')) });
op('post', '/admin/rooms/mapping/adapters/{id}/secret', { tag: 'Rooms and devices', summary: 'New adapter webhook secret', perm: 'mapping:manage', description: 'The secret is returned once. Give it to the device vendor.', params: [pathId()], data: obj({ adapterId: int(), webhookSecret: str(), webhookUrl: str() }), errors: [404] });
op('post', '/admin/rooms/mapping/adapters/{id}/check', { tag: 'Rooms and devices', summary: 'Run an adapter health check now', perm: 'mapping:manage', params: [pathId()], data: ref('Adapter'), errors: [404] });
op('get', '/admin/rooms/availability', {
  tag: 'Front desk',
  summary: 'Free rooms for a date range',
  perm: 'stays:read',
  params: [q('from', dt(), null, true), q('to', dt(), null, true), q('roomType', str())],
  data: ref('Availability'),
});

// Requests
op('get', '/admin/requests', {
  tag: 'Requests',
  summary: 'Request queue',
  perm: 'requests:read',
  description: 'Escalated first, then by priority, then oldest. `openCounts` feeds the column headers.',
  params: [
    q('status', csv(REQUEST_STATUSES)),
    q('category', csv(REQUEST_CATEGORIES)),
    q('priority', csv(PRIORITIES)),
    q('roomId', int()),
    q('assignedTo', str({ description: 'Staff id or "me"' })),
    q('unassigned', bool()),
    q('escalated', bool()),
    q('from', dt()),
    q('to', dt()),
    ...pageParams,
  ],
  data: { allOf: [page(ref('Request')), obj({ openCounts: obj({ new: int(), assigned: int(), in_progress: int() }) })] },
});
op('get', '/admin/requests/assignees', {
  tag: 'Requests',
  summary: 'Staff who can be assigned requests',
  perm: 'requests:write',
  description: 'For the assignee picker: active service staff, managers and admins with their current open request count.',
  data: arr(obj({ id: int(), name: str(), role: enm(ROLES), openRequests: int() })),
});
op('get', '/admin/requests/{id}', { tag: 'Requests', summary: 'Request with history', perm: 'requests:read', params: [pathId()], data: ref('RequestDetail'), errors: [404] });
op('post', '/admin/requests', {
  tag: 'Requests',
  summary: 'Create a request on behalf of a guest',
  perm: 'requests:write',
  description: 'Linked to the guest checked in to the room, if any.',
  body: obj({ roomId: int(), category: enm(REQUEST_CATEGORIES), description: str({ maxLength: 1000 }), priority: enm(PRIORITIES), preferredAt: dt() }, ['roomId', 'category']),
  data: ref('Request'),
  status: 201,
});
op('patch', '/admin/requests/{id}', {
  tag: 'Requests',
  summary: 'Assign, change status or priority, add a note',
  perm: 'requests:write',
  description:
    'Allowed status changes: new > assigned, in_progress, done, cancelled; assigned > new, in_progress, done, cancelled; in_progress > assigned, done, cancelled. done and cancelled are final (notes still allowed). Assigning a new request moves it to assigned; `assignedTo: null` unassigns. The guest gets a push on each status change.',
  params: [pathId()],
  body: opt({ status: enm(REQUEST_STATUSES), assignedTo: nul(int()), priority: enm(PRIORITIES), note: str({ maxLength: 1000 }) }),
  data: ref('RequestDetail'),
  errors: [404],
});

// Alerts
op('get', '/admin/alerts', {
  tag: 'Alerts',
  summary: 'Alerts',
  perm: 'alerts:read',
  params: [
    q('status', enm(['open', 'resolved'])),
    q('type', csv(ALERT_TYPES)),
    q('severity', csv(['info', 'warning', 'critical'])),
    q('source', csv(['device', 'guest', 'system'])),
    q('roomId', int()),
    q('floor', int()),
    q('from', dt()),
    q('to', dt()),
    ...pageParams,
  ],
  data: { allOf: [page(ref('Alert')), obj({ openCounts: obj({ critical: int(), warning: int(), info: int() }) })] },
});
op('get', '/admin/alerts/{id}', { tag: 'Alerts', summary: 'Alert with device history', perm: 'alerts:read', params: [pathId()], data: ref('AlertDetail'), errors: [404] });
op('patch', '/admin/alerts/{id}', {
  tag: 'Alerts',
  summary: 'Resolve an alert',
  perm: 'alerts:resolve',
  description: 'A note of at least 3 characters is required.',
  params: [pathId()],
  body: obj({ status: { const: 'resolved' }, note: str({ minLength: 3, maxLength: 1000 }) }),
  data: ref('Alert'),
  errors: [404],
});

// Feedback
op('get', '/admin/feedback', {
  tag: 'Feedback',
  summary: 'Feedback with averages',
  perm: 'feedback:read',
  params: [
    q('from', dt()),
    q('to', dt()),
    q('minRating', int({ minimum: 1, maximum: 5 })),
    q('maxRating', int({ minimum: 1, maximum: 5 })),
    q('roomId', int()),
    q('floor', int()),
    q('category', str()),
    q('hasPhotos', bool()),
    q('groupBy', enm(['day', 'week', 'month'], { default: 'day' })),
    ...pageParams,
  ],
  data: {
    allOf: [
      page(ref('Feedback')),
      obj({
        summary: obj({ count: int(), average: nul(num()), distribution: obj({ 1: int(), 2: int(), 3: int(), 4: int(), 5: int() }) }),
        averages: obj({ groupBy: str(), periods: arr(obj({ period: str({ example: '2026-W43' }), count: int(), average: num() })) }),
      }),
    ],
  },
});

// Staff accounts
op('get', '/admin/staff', { tag: 'Staff accounts', summary: 'List staff', perm: 'staff:manage', params: [q('role', enm(ROLES)), q('active', bool()), q('q', str({ description: 'Name or email' })), ...pageParams], data: page(ref('Staff')) });
op('get', '/admin/staff/{id}', { tag: 'Staff accounts', summary: 'Staff member', perm: 'staff:manage', params: [pathId()], data: ref('Staff'), errors: [404] });
op('post', '/admin/staff', {
  tag: 'Staff accounts',
  summary: 'Create staff account',
  perm: 'staff:manage',
  body: obj({ name: str({ minLength: 2 }), email: str({ format: 'email' }), role: enm(ROLES), password: str({ description: '10+ characters with a letter and a number' }) }),
  data: ref('Staff'),
  status: 201,
  errors: [409],
});
op('patch', '/admin/staff/{id}', {
  tag: 'Staff accounts',
  summary: 'Edit, deactivate, reset password or unlock',
  perm: 'staff:manage',
  description: 'Deactivating, changing role or resetting the password signs the person out everywhere. Admins cannot deactivate themselves or change their own role.',
  params: [pathId()],
  body: opt({ name: str(), email: str({ format: 'email' }), role: enm(ROLES), isActive: bool(), password: str(), resetOtp: { const: true }, unlock: { const: true } }),
  data: ref('Staff'),
  errors: [404, 409],
});

// Settings
op('get', '/admin/settings', { tag: 'Hotel settings', summary: 'Hotel settings', perm: 'settings:manage', data: ref('Settings') });
op('put', '/admin/settings', {
  tag: 'Hotel settings',
  summary: 'Update hotel settings',
  perm: 'settings:manage',
  description: 'Send all settings or only the ones that changed. ac_min_temp must be below ac_max_temp and eco_setpoint inside that range.',
  body: { ...schemas.Settings, required: [] },
  data: ref('Settings'),
});

// Audit
op('get', '/admin/audit', {
  tag: 'Audit log',
  summary: 'Search the audit log',
  perm: 'audit:read',
  params: [
    q('staffId', int()),
    q('actorType', enm(['staff', 'guest', 'system'])),
    q('action', str({ description: 'Exact (room.unlock) or prefix ending in a dot (request.)' })),
    q('entityType', str()),
    q('entityId', str()),
    q('roomId', int()),
    q('roomNumber', str()),
    q('from', dt()),
    q('to', dt()),
    q('q', str({ description: 'Free text in action, staff name/email and details' })),
    ...pageParams,
  ],
  data: page(ref('AuditEntry')),
});

// Rules
op('get', '/admin/rules', { tag: 'Rules (Release 2)', summary: 'List rules', perm: 'rules:manage', params: [q('type', enm(['schedule', 'vacancy'])), q('enabled', bool())], data: arr(ref('Rule')) });
op('get', '/admin/rules/{id}', { tag: 'Rules (Release 2)', summary: 'Rule with its last 20 runs', perm: 'rules:manage', params: [pathId()], data: { allOf: [ref('Rule'), obj({ recentRuns: arr(ref('RuleRun')) })] }, errors: [404] });
op('get', '/admin/rules/{id}/runs', { tag: 'Rules (Release 2)', summary: 'Run history', perm: 'rules:manage', params: [pathId(), ...pageParams], data: page(ref('RuleRun')), errors: [404] });
op('post', '/admin/rules', { tag: 'Rules (Release 2)', summary: 'Create rule', perm: 'rules:manage', body: ref('RuleInput'), data: ref('Rule'), status: 201 });
op('patch', '/admin/rules/{id}', { tag: 'Rules (Release 2)', summary: 'Edit, enable or disable a rule', perm: 'rules:manage', params: [pathId()], body: { ...schemas.RuleInput, required: [] }, data: ref('Rule'), errors: [404] });
op('post', '/admin/rules/{id}/run', { tag: 'Rules (Release 2)', summary: 'Run a rule now', perm: 'rules:manage', params: [pathId()], data: ref('RuleRun'), errors: [404] });

// Energy
const energyParams = [
  q('from', dt({ description: 'Default: 7 days ago' })),
  q('to', dt({ description: 'Default: now' })),
  q('interval', enm(['hour', 'day', 'month'], { default: 'day', description: 'hour is limited to 31 days' })),
  q('floor', str({ description: 'Comma-separated floor numbers' })),
  q('roomId', int()),
];
op('get', '/admin/energy', { tag: 'Energy (Release 2)', summary: 'Energy by room or floor, with top 10', perm: 'energy:read', params: [...energyParams, q('groupBy', enm(['room', 'floor'], { default: 'room' }))], data: ref('Energy') });
op('get', '/admin/energy/export', {
  tag: 'Energy (Release 2)',
  summary: 'Energy CSV',
  perm: 'energy:read',
  description: 'Columns: period, floor, room, kwh. Download with fetch + blob (it needs the Authorization header).',
  params: energyParams,
  raw: { description: 'CSV file', content: { 'text/csv': { schema: str() } } },
});

// Front desk, stays, guests
op('get', '/admin/front-desk/today', { tag: 'Front desk', summary: "Today's arrivals, departures and overdue check-outs", perm: 'stays:read', data: ref('FrontDeskToday') });
op('get', '/admin/stays', {
  tag: 'Stays',
  summary: 'Search stays',
  perm: 'stays:read',
  params: [
    q('status', csv(STAY_STATUSES)),
    q('arrivalDate', str({ format: 'date', description: 'Hotel-local date YYYY-MM-DD' })),
    q('departureDate', str({ format: 'date' })),
    q('inHouse', bool()),
    q('roomId', int()),
    q('q', str({ description: 'Guest name, email, phone, booking reference or room number' })),
    ...pageParams,
  ],
  data: page(ref('Stay')),
});
op('get', '/admin/stays/{id}', { tag: 'Stays', summary: 'Stay with guests, history, requests and keys', perm: 'stays:read', params: [pathId()], data: ref('StayDetail'), errors: [404] });
op('post', '/admin/stays', {
  tag: 'Stays',
  summary: 'Create a reservation or walk-in',
  perm: 'stays:write',
  description:
    'Reservation: `arrival` + `departure`, room optional. Walk-in: `checkInNow: true` + `roomId` + `departure`; the response is then a check-in result with the access code. `guest` is either `{ id }` for a returning guest or new guest details. 409 when the room is booked for those dates or the hotel runs in PMS booking mode.',
  body: obj(
    {
      guest: { oneOf: [obj({ id: int() }), ref('GuestInput')] },
      companions: arr({ oneOf: [obj({ id: int() }), ref('GuestInput')] }),
      roomId: int(),
      roomType: str(),
      arrival: dt(),
      departure: dt(),
      adults: int({ minimum: 1, default: 1 }),
      children: int({ minimum: 0, default: 0 }),
      notes: str(),
      checkInNow: bool(),
    },
    ['guest', 'departure'],
  ),
  data: { oneOf: [obj({ stay: ref('StayDetail') }), ref('CheckInResult')] },
  status: 201,
  errors: [409],
});
op('patch', '/admin/stays/{id}', {
  tag: 'Stays',
  summary: 'Edit a booking',
  perm: 'stays:write',
  description: 'For checked-in stays only departure, guest counts, notes and addGuests can change here (use move and extend for room and dates).',
  params: [pathId()],
  body: opt({ arrival: dt(), departure: dt(), roomId: nul(int()), roomType: nul(str()), adults: int(), children: int(), notes: nul(str()), addGuests: arr({ oneOf: [obj({ id: int() }), ref('GuestInput')] }) }),
  data: ref('StayDetail'),
  errors: [404, 409],
});
op('post', '/admin/stays/{id}/check-in', {
  tag: 'Stays',
  summary: 'Check in',
  perm: 'stays:write',
  description: 'Issues digital keys on the room locks and a 6-digit guest app code (returned once, also emailed to the guest). Show `warnings` to the receptionist. 409 if the room already has a checked-in guest.',
  params: [pathId()],
  body: opt({ roomId: int({ description: 'Required if the reservation has no room yet' }) }),
  bodyRequired: false,
  data: ref('CheckInResult'),
  errors: [404, 409],
});
op('post', '/admin/stays/{id}/check-out', {
  tag: 'Stays',
  summary: 'Check out',
  perm: 'stays:write',
  description: 'Revokes keys and guest app access, removes push tokens, closes open guest requests (maintenance requests stay open).',
  params: [pathId()],
  body: opt({ note: str() }),
  bodyRequired: false,
  data: obj({ stay: ref('StayDetail'), keysRevoked: int(), keysFailed: int({ description: 'If > 0 a critical alert was raised; the system keeps retrying' }), requestsClosed: int() }),
  errors: [404],
});
op('post', '/admin/stays/{id}/move', {
  tag: 'Stays',
  summary: 'Move to another room',
  perm: 'stays:write',
  params: [pathId()],
  body: obj({ roomId: int(), reason: str() }, ['roomId']),
  data: obj({ stay: ref('StayDetail'), keys: arr(ref('DigitalKey')) }),
  errors: [404, 409],
});
op('post', '/admin/stays/{id}/extend', { tag: 'Stays', summary: 'Change the departure (extend or shorten)', perm: 'stays:write', params: [pathId()], body: obj({ departure: dt() }), data: ref('StayDetail'), errors: [404, 409] });
op('post', '/admin/stays/{id}/cancel', { tag: 'Stays', summary: 'Cancel a reservation', perm: 'stays:write', params: [pathId()], body: opt({ reason: str() }), bodyRequired: false, data: ref('StayDetail'), errors: [404] });
op('post', '/admin/stays/{id}/no-show', { tag: 'Stays', summary: 'Mark a reservation as no-show', perm: 'stays:write', params: [pathId()], body: opt({ reason: str() }), bodyRequired: false, data: ref('StayDetail'), errors: [404] });
op('post', '/admin/stays/{id}/access-code', {
  tag: 'Stays',
  summary: 'New guest app access code',
  perm: 'stays:write',
  description: 'The old code and QR stop working. `signOutDevices` (default true) also signs out phones already using the app; `email` sends the new code to the guest.',
  params: [pathId()],
  body: opt({ signOutDevices: bool({ default: true }), email: bool({ default: false }) }),
  bodyRequired: false,
  data: obj({ accessCode: str(), qrToken: str(), qrUrl: str() }),
  errors: [404],
});
op('post', '/admin/stays/{id}/keys', { tag: 'Stays', summary: 'Revoke and re-issue digital keys', perm: 'stays:write', params: [pathId()], data: obj({ keys: arr(ref('DigitalKey')) }), errors: [404] });
op('get', '/admin/stays/{id}/qr', { tag: 'Stays', summary: 'Get current QR access code', perm: 'stays:read', params: [pathId()], data: obj({ accessCode: str(), qrToken: str(), qrUrl: str() }), errors: [404] });
op('post', '/admin/stays/scan-qr', { tag: 'Stays', summary: 'Scan guest QR code', perm: 'stays:read', body: obj({ qrData: str(), checkInNow: bool(), roomId: int() }, ['qrData']), data: obj({ stay: ref('StayDetail') }), errors: [400, 404] });

op('get', '/admin/guests', { tag: 'Guests', summary: 'Search guests', perm: 'stays:read', params: [q('q', str({ description: 'Name, email, phone or booking reference' })), q('vip', bool()), q('includeAnonymized', bool()), ...pageParams], data: page(ref('Guest')) });
op('get', '/admin/guests/{id}', { tag: 'Guests', summary: 'Guest profile with stay history', perm: 'stays:read', params: [pathId()], data: { allOf: [ref('Guest'), obj({ stays: arr(ref('Stay')) })] }, errors: [404] });
op('post', '/admin/guests', { tag: 'Guests', summary: 'Create guest profile', perm: 'stays:write', body: { allOf: [ref('GuestInput'), opt({ notes: str() })] }, data: { allOf: [ref('Guest'), obj({ stays: arr(ref('Stay')) })] }, status: 201 });
op('patch', '/admin/guests/{id}', { tag: 'Guests', summary: 'Edit guest profile', perm: 'stays:write', params: [pathId()], body: opt({ firstName: str(), lastName: str(), email: nul(str()), phone: nul(str()), language: str(), vip: bool(), notes: nul(str()) }), data: { allOf: [ref('Guest'), obj({ stays: arr(ref('Stay')) })] }, errors: [404] });
op('post', '/admin/guests/{id}/anonymise', { tag: 'Guests', summary: 'Remove personal details', perm: 'guests:anonymize', description: 'Allowed only when the guest has no current or future stay (409 otherwise).', params: [pathId()], data: { allOf: [ref('Guest'), obj({ stays: arr(ref('Stay')) })] }, errors: [404, 409] });

// PMS admin
op('get', '/admin/pms/connections', { tag: 'PMS sync', summary: 'PMS connections', perm: 'pms:manage', data: arr(ref('PmsConnection')) });
op('post', '/admin/pms/connections', { tag: 'PMS sync', summary: 'Add PMS connection', perm: 'pms:manage', body: obj({ name: str(), vendor: enm(['http', 'mock']), config: anyObj('http: { baseUrl, apiKey?, timeoutMs?, paths? }'), isEnabled: bool() }, ['name', 'vendor']), data: ref('PmsConnection'), status: 201 });
op('patch', '/admin/pms/connections/{id}', { tag: 'PMS sync', summary: 'Edit PMS connection', perm: 'pms:manage', params: [pathId()], body: opt({ name: str(), config: anyObj(), isEnabled: bool() }), data: ref('PmsConnection'), errors: [404] });
op('post', '/admin/pms/connections/{id}/secret', { tag: 'PMS sync', summary: 'New PMS webhook secret (shown once)', perm: 'pms:manage', params: [pathId()], data: obj({ connectionId: int(), webhookSecret: str(), webhookUrl: str() }), errors: [404] });
op('post', '/admin/pms/connections/{id}/sync', {
  tag: 'PMS sync',
  summary: 'Reconcile in-house guests now',
  perm: 'pms:manage',
  params: [pathId()],
  data: obj({ summary: obj({ checkedIn: int(), checkedOut: int(), moved: int(), failed: int() }), connection: ref('PmsConnection') }),
  errors: [404],
  raw: undefined,
});
op('get', '/admin/pms/events', { tag: 'PMS sync', summary: 'PMS event log', perm: 'pms:manage', params: [q('connectionId', int()), q('status', enm(['pending', 'processed', 'ignored', 'failed'])), ...pageParams], data: page(ref('PmsEvent')) });
op('post', '/admin/pms/events/{id}/retry', { tag: 'PMS sync', summary: 'Retry a failed PMS event', perm: 'pms:manage', params: [pathId()], data: obj({ id: int(), status: str(), result: str() }), errors: [404] });

// Guest app
op('post', '/guest/forgot-password', {
  tag: 'Guest app',
  summary: 'Request password reset code',
  body: obj({ email: str({ format: 'email' }) }, ['email']),
  data: obj({ message: str() }),
});
op('post', '/guest/reset-password', {
  tag: 'Guest app',
  summary: 'Reset password with 6-digit verification code',
  body: obj({ email: str({ format: 'email' }), code: str(), newPassword: str() }, ['email', 'code', 'newPassword']),
  data: obj({ message: str() }),
  errors: [400],
});
op('post', '/guest/register', {
  tag: 'Guest app',
  summary: 'Register permanent guest profile',
  body: obj({ firstName: str(), lastName: str(), email: str(), phone: opt(str()) }),
  data: obj({ guest: obj({ id: num(), firstName: str(), lastName: str(), email: str() }) }),
});

op('get', '/guest/history', {
  tag: 'Guest app',
  summary: 'List past and current stays for this guest',
  auth: 'guest',
  data: arr(obj({ id: num(), reference: str(), suiteNumber: str(), suiteType: str(), checkInDate: dt(), checkOutDate: dt(), nights: num(), status: str() })),
});

op('get', '/guest/info', {
  tag: 'Guest app',
  summary: 'Help and welcome content',
  auth: 'none',
  description: 'Public, for the welcome and help screens: reception phone, FAQs, privacy notice and quick links (edited in hotel settings).',
  data: obj({ hotelName: str(), receptionPhone: nul(str()), faqs: arr(obj({ question: str(), answer: str() })), privacyNotice: nul(str()), quickLinks: arr(ref('QuickLink')) }),
});
op('post', '/guest/link-booking', {
  tag: 'Guest app',
  summary: 'Link a stay to the current authenticated guest session',
  auth: 'guest',
  body: obj({
    bookingCode: opt(str()),
    reference: opt(str()),
    lastName: opt(str()),
    qrToken: opt(str()),
  }),
  data: obj({
    stayId: num(),
    reference: str(),
    roomNumber: str(),
  }),
  errors: [403, 404],
});

op('post', '/guest/login', {
  tag: 'Guest app',
  summary: 'Exchange a booking code or QR for a guest token',
  auth: 'none',
  description: [
    'One of:',
    '- `bookingCode`: the 8-character code from check-in (spaces, dashes and lower case are fine)',
    '- `qrToken`: the `token` parameter of the check-in QR / login link (`smartstay://login?token=...`)',
    '- `reference` + `lastName`: fallback; any guest on the booking, case and accents ignored',
    '',
    'Only checked-in stays can sign in (403 `NOT_CHECKED_IN` for reservations). 409 `DEVICE_LIMIT` when the room already has the allowed number of phones signed in. 423 `GUEST_ACCESS_LOCKED` after 10 wrong last names.',
  ].join('\n'),
  body: { oneOf: [obj({ bookingCode: str({ example: 'K7Q2MPX4' }) }), obj({ qrToken: str() }), obj({ reference: str({ example: 'SS7KQ2MP' }), lastName: str() })] },
  data: ref('GuestSession'),
  status: 201,
  errors: [401, 403, 409, 423, 429],
});
op('post', '/guest/logout', { tag: 'Guest app', summary: 'Sign out this phone', auth: 'guest', description: 'Frees a place for another phone in the room.' });
op('get', '/guest/me', {
  tag: 'Guest app',
  summary: 'Booking, room, stay dates, room status, key and eco state',
  auth: 'guest',
  description: '401 `GUEST_SESSION_ENDED` once the guest checks out or the front desk resets access: go back to the login screen.',
  data: ref('GuestMe'),
});
op('put', '/guest/push-token', { tag: 'Guest app', summary: 'Register this phone for push notifications', auth: 'guest', body: obj({ pushToken: str({ description: 'FCM registration token' }), platform: enm(['ios', 'android', 'web']) }) });

op('get', '/guest/key', {
  tag: 'Guest app',
  summary: 'Key credentials for the Bluetooth SDK',
  auth: 'guest',
  description: 'Only inside the stay window; otherwise 403 `KEY_NOT_ACTIVE`. `methods.ble` means the app can unlock with the vendor SDK using `credential`; `methods.remote` means POST /guest/key/unlock works (the web app only has this).',
  data: ref('GuestKeyInfo'),
  errors: [403],
});
op('post', '/guest/key/unlock', {
  tag: 'Guest app',
  summary: 'Cloud unlock (fallback to Bluetooth, and the web app’s only method)',
  auth: 'guest',
  description: '502 `UNLOCK_FAILED` if the lock did not open; 403 `KEY_NOT_ACTIVE` or `FORBIDDEN` if there is no valid key for that door.',
  body: opt({ deviceId: int({ description: 'Only when the room has more than one lock' }) }),
  bodyRequired: false,
  data: obj({ deviceId: int(), unlockedAt: dt() }),
  errors: [403, 429],
});

op('get', '/guest/devices', { tag: 'Guest app', summary: 'Devices in my room with live state', auth: 'guest', description: 'Lights, AC, curtains, TV and speaker. Keep live with the `device:state` event on the /guest socket namespace.', data: obj({ eco: ref('EcoState'), devices: arr(ref('GuestDevice')) }) });
op('post', '/guest/devices/{id}/command', {
  tag: 'Guest app',
  summary: 'Control a device',
  auth: 'guest',
  description: [
    'Body depends on the device type, and is checked against the device `capabilities` and the hotel AC range:',
    '- light: `{ on?, brightness? }` (brightness only if `dimmable`)',
    '- thermostat: `{ power?, setpoint?, mode?, fan? }` (setpoint within minTemp..maxTemp in `step`s). Any change ends eco.',
    '- curtain: `{ action: open|close|stop }` or `{ position: 0-100 }` (position only if `positionable`)',
    '- tv: `{ power?, volume?, mute?, channel?, input? }`',
    '- speaker: `{ power?, volume?, playing?, source? }`',
    '',
    '404 for a device outside your room, 409 `DEVICE_OFFLINE`, 502 `COMMAND_FAILED` when the device did not respond, 429 when sending too fast.',
  ].join('\n'),
  params: [pathId()],
  body: { oneOf: [ref('LightCommand'), ref('ThermostatCommand'), ref('CurtainCommand'), ref('TvCommand'), ref('SpeakerCommand')] },
  data: obj({ device: ref('GuestDevice'), latencyMs: int() }),
  errors: [404, 409, 429],
});
op('put', '/guest/room-status', {
  tag: 'Guest app',
  summary: 'Do not disturb / request cleaning',
  auth: 'guest',
  description: 'They exclude each other: requesting cleaning turns DND off, and DND cancels a pending cleaning request. Requesting cleaning creates a housekeeping request.',
  body: opt({ dnd: bool(), cleaningRequested: bool(), note: str({ maxLength: 300, description: 'Optional note for housekeeping' }) }),
  data: ref('RoomStatus'),
});

op('get', '/guest/requests', { tag: 'Guest app', summary: 'My requests', auth: 'guest', data: arr(ref('GuestRequest')) });
op('get', '/guest/requests/{id}', { tag: 'Guest app', summary: 'Request with timeline', auth: 'guest', params: [pathId()], data: ref('GuestRequestDetail'), errors: [404] });
op('post', '/guest/requests', {
  tag: 'Guest app',
  summary: 'New request',
  auth: 'guest',
  body: obj({ category: enm(REQUEST_CATEGORIES), description: str({ maxLength: 1000 }), preferredAt: dt({ description: 'Between now and the end of the stay' }) }, ['category']),
  data: ref('GuestRequestDetail'),
  status: 201,
  errors: [429],
});
op('post', '/guest/requests/{id}/cancel', { tag: 'Guest app', summary: 'Cancel before it is in progress', auth: 'guest', description: '409 once a team member has started or it is finished.', params: [pathId()], data: ref('GuestRequestDetail'), errors: [404, 409] });

op('post', '/guest/feedback', {
  tag: 'Guest app',
  summary: 'Send feedback, with photos',
  auth: 'guest',
  description: 'Send `multipart/form-data` with up to 3 files in `photos` (JPEG, PNG, WebP or HEIC, 5 MB each), or JSON without photos. `markAsIssue` also puts it in the staff alert list.',
  raw: undefined,
  data: obj({ id: int(), photos: int(), markedAsIssue: bool() }),
  status: 201,
  errors: [429],
});
paths['/guest/feedback'].post.requestBody = {
  required: true,
  content: {
    'multipart/form-data': {
      schema: obj({ rating: int({ minimum: 1, maximum: 5 }), category: str(), comment: str({ maxLength: 2000 }), markAsIssue: bool(), photos: arr(str({ format: 'binary' }), { maxItems: 3 }) }, ['rating']),
    },
    'application/json': { schema: obj({ rating: int({ minimum: 1, maximum: 5 }), category: str(), comment: str({ maxLength: 2000 }), markAsIssue: bool() }, ['rating']) },
  },
};

op('get', '/guest/preferences', { tag: 'Guest app', summary: 'My saved preferences (Release 2)', auth: 'guest', data: obj({ preferences: ref('Preferences'), updatedAt: nul(dt()) }) });
op('put', '/guest/preferences', {
  tag: 'Guest app',
  summary: 'Save preferences (Release 2)',
  auth: 'guest',
  description: 'Saved for future stays and applied at check-in. `applyNow: true` also applies them to the room now.',
  body: obj({ preferences: ref('Preferences'), applyNow: bool() }, ['preferences']),
  data: obj({ preferences: ref('Preferences'), updatedAt: nul(dt()), applied: nul(ref('PreferencesApplied')) }),
});

op('get', '/media/feedback-photos/{id}', {
  tag: 'Feedback',
  summary: 'Feedback photo (signed link)',
  auth: 'none',
  description: 'Use the `url` from GET /admin/feedback as-is (it carries `exp` and `sig` and expires after an hour). 403 `LINK_EXPIRED` when the link is no longer valid.',
  params: [pathId(), q('exp', int(), null, true), q('sig', str(), null, true)],
  raw: { description: 'Image', content: { 'image/*': { schema: str({ format: 'binary' }) } } },
  errors: [403, 404],
});

// Integrations (server to server)
op('post', '/integrations/adapters/{id}/events', {
  tag: 'Integrations (server to server)',
  summary: 'Device events from a vendor',
  auth: 'adapter',
  params: [pathId('id', 'Adapter id')],
  body: obj({ events: arr(obj({ externalId: str(), type: enm(DEVICE_EVENTS), payload: anyObj(), occurredAt: dt() }, ['externalId', 'type'])) }),
  data: obj({ accepted: int(), results: arr(obj({ externalId: str(), accepted: bool(), reason: str() }, ['externalId', 'accepted'])) }),
  status: 202,
});
op('post', '/integrations/pms/{id}/events', {
  tag: 'Integrations (server to server)',
  summary: 'Reservation events from the PMS',
  auth: 'pms',
  description: 'Each event carries the full reservation. `eventId` is processed once; events older than the last applied change are ignored.',
  params: [pathId('id', 'PMS connection id')],
  body: obj({ events: arr(obj({ eventId: str(), type: enm(PMS_EVENTS), occurredAt: dt(), reservation: ref('PmsReservation') }, ['eventId', 'type', 'reservation'])) }),
  data: obj({ results: arr(obj({ eventId: str(), status: enm(['processed', 'ignored', 'failed', 'duplicate']), result: str() }, ['eventId', 'status'])) }),
  status: 202,
});

/* ----------------------------------------------------------- document */

export function buildOpenApi({ serverUrl } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'SmartStay API',
      version: '1.0.0',
      description: [
        'API for the SmartStay staff dashboard and guest app. See docs/FRONTEND_GUIDE.md for sign-in, token refresh, live updates and screen-by-screen flows.',
        '',
        '- Every route also works under the `/api` prefix.',
        '- Success responses: `{ "success": true, "data": ... }`. Errors: `{ "success": false, "code", "message", "details"? }`.',
        '- Dates are ISO 8601 in UTC. Lists take `page` and `limit` and return `{ items, page, limit, total }`.',
        '- Staff endpoints use the staff token; guest app endpoints use the guest token. They are not interchangeable.',
      ].join('\n'),
    },
    servers: [{ url: serverUrl || 'http://localhost:5000', description: 'API server' }],
    tags: [
      'Health', 'Staff auth', 'Room board', 'Rooms and devices', 'Requests', 'Alerts', 'Feedback', 'Staff accounts', 'Hotel settings',
      'Audit log', 'Rules (Release 2)', 'Energy (Release 2)', 'Front desk', 'Stays', 'Guests', 'PMS sync', 'Guest app', 'Integrations (server to server)',
    ].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        staffBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'accessToken from POST /staff/login' },
        guestBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'token from POST /guest/session' },
        adapterSecret: { type: 'apiKey', in: 'header', name: 'X-Adapter-Secret' },
        pmsSecret: { type: 'apiKey', in: 'header', name: 'X-PMS-Secret' },
      },
      schemas,
    },
  };
}
