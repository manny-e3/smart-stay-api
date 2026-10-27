# Adding an endpoint

Every endpoint in this API is built the same way, from the database up to the URL:

```
model  →  service  →  controller  →  validator  →  route  →  docs  →  test
SQL       rules       req / res      allowed input   URL       OpenAPI   proof
```

This guide adds one example endpoint, **"list the stays of one room"**, and shows each file you touch.

```
GET /admin/rooms/:id/stays?status=checked_out&limit=10
```

## 1. Model: the SQL (`src/models/`)

Models are the only files that talk to the database. Each function runs one query and returns rows.
Stays live in `stays`, so the function goes in `src/models/stay.model.js`:

```js
/** Stays in a room, newest first. Optional status filter. */
export function listForRoom(roomId, { status, limit = 20 } = {}) {
  const q = db('stays as s')
    .join('guests as g', 'g.id', 's.guest_id')
    .where('s.room_id', roomId)
    .orderBy('s.check_in_at', 'desc')
    .limit(limit)
    .select('s.id', 's.reference', 's.status', 's.check_in_at', 's.check_out_at', 'g.first_name', 'g.last_name');
  if (status) q.where('s.status', status);
  return q;
}
```

Rules for models:

- Keep each function small and name it after what it returns: `findById`, `listForRoom`, `countCheckedIn`.
- Functions that write take an optional last argument `trx = db`. A service passes the transaction there so
  several writes commit together (see step 2).
- No business rules here. "Only managers may see this" or "the room must be active" belong in the service.
- JSON columns (`config`, `state`, `payload`, `data`, `details`, `value`, `preferences`, ...) are parsed
  automatically, but only when they keep their column name. Don't rename them with `as`.

## 2. Service: the business rules (`src/services/`)

Services decide what is allowed and what happens. They call model functions, never write SQL, and never
see `req` or `res`, so the same function works from a route, a background job or a test.

In `src/services/rooms.service.js`:

```js
import * as Room from '../models/room.model.js';
import * as Stay from '../models/stay.model.js';
import { notFound } from '../utils/errors.js';

/** Stays of one room for the room history panel. */
export async function getRoomStays(roomId, { status, limit }) {
  const room = await Room.findById(roomId);
  if (!room) throw notFound('Room'); // becomes a 404 JSON response automatically

  const stays = await Stay.listForRoom(roomId, { status, limit });
  return stays.map((s) => ({
    id: s.id,
    reference: s.reference,
    status: s.status,
    guest: `${s.first_name} ${s.last_name ?? ''}`.trim(),
    arrival: s.check_in_at,
    departure: s.check_out_at,
  }));
}
```

Things services often do:

- **Throw errors** from `src/utils/errors.js`: `badRequest()` (400), `notFound()` (404), `conflict()` (409).
  The error handler turns them into `{ success: false, code, message }`.
- **Use a transaction** when several writes must all succeed or all fail:

  ```js
  import { transaction } from '../config/db.js';

  await transaction(async (trx) => {
    await Stay.update(stayId, { status: 'checked_out' }, trx);
    await Room.update(roomId, { dnd: false }, trx);
  });
  ```

- **Publish an event** so screens update live: `bus.publish(EVENTS.ROOM_CHANGED, { roomId })`
  (see `src/realtime/`). The service never talks to Socket.IO directly.
- **Write the audit log** with `recordAudit(...)` from `services/audit.service.js` for staff actions.
- Convert database rows (`check_in_at`) to API fields (`arrival`). The API always uses camelCase.

## 3. Controller: request in, response out (`src/controllers/`)

A controller is a thin function per endpoint. It reads the already-checked input from `req.valid`, calls the
service and sends the response. In `src/controllers/rooms.controller.js`:

```js
/** GET /admin/rooms/:id/stays */
export async function listStays(req, res) {
  const data = await roomsService.getRoomStays(req.valid.params.id, req.valid.query);
  res.json({ success: true, data });
}
```

- Read input from **`req.valid`** (`req.valid.params`, `req.valid.query`, `req.valid.body`). These are the
  values after validation, so numbers are numbers and defaults are filled in.
- The signed-in user is **`req.staff`** (`{ id, role, ... }`) on admin routes and **`req.guest`**
  (`{ guestId, stayId, roomId, ... }`) on guest app routes.
- No `try/catch` needed: Express 5 sends thrown errors to the error handler.
- Successful responses always look like `{ success: true, data }`. Use `res.status(201)` when creating something.

## 4. Validator: what input is allowed (`src/validators/`)

Validators are [zod](https://zod.dev) schemas. Anything that doesn't match is rejected with a 400 before your
controller runs. In `src/validators/rooms.validator.js`:

```js
import { STAY_STATUSES } from '../services/stays.service.js';

/** GET /admin/rooms/:id/stays */
export const roomStaysQuery = z.object({
  status: z.enum(STAY_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20), // query values arrive as text: coerce
});
```

Shared pieces live in `src/validators/common.validator.js`: `idParam` (a positive `:id`), `pageQuery`,
`boolish` (accepts `true`/`false`/`1`/`0` in query strings), `csvEnum`, and others.

## 5. Route: the URL (`src/routes/`)

The route file lists URLs, in order, with the middleware that runs before the controller. In
`src/routes/rooms.routes.js`:

```js
router.get('/:id/stays', authorize('stays:read'), validate({ params: idParam, query: v.roomStaysQuery }), rooms.listStays);
```

Read it left to right:

| Piece | What it does |
|---|---|
| `'/:id/stays'` | The path. The file is mounted at `/admin/rooms` in `src/routes/index.js`, so the full URL is `/admin/rooms/:id/stays`. |
| `authorize('stays:read')` | Only roles with this permission get in (others get 403). Permissions and their roles are in `src/config/permissions.js`. |
| `validate({ params, query, body })` | Checks input against the validator and puts the result on `req.valid`. |
| `rooms.listStays` | The controller. |

- All `/admin/*` routes already require a staff sign-in (set once in `routes/index.js`). Guest app routes
  after `router.use(authenticateGuest)` in `guestApp.routes.js` require a guest sign-in.
- Put fixed paths (`/board`, `/mapping`) **before** `/:id` paths, or Express reads `board` as an id.
- A whole new area gets its own route file. Mount it in `src/routes/index.js` and add it to `MOUNTS` in
  `tests/openapi.test.js`.
- Rate limits: `limiter({ limit, minutes })` from `src/middleware/rateLimit.js` for anything that can be abused
  (sign-in, public forms).

## 6. Docs: tell the frontend (`src/docs/openapi.js`)

Every route must be documented, or `tests/openapi.test.js` fails. Add one `op(...)` call near the related routes:

```js
op('get', '/admin/rooms/{id}/stays', {
  tag: 'Rooms and devices',
  summary: 'Stays of one room',
  perm: 'stays:read',
  params: [pathId(), q('status', enm(STAY_STATUSES)), q('limit', int({ minimum: 1, maximum: 100, default: 20 }))],
  data: arr(obj({ id: int(), reference: str(), status: enm(STAY_STATUSES), guest: str(), arrival: dt(), departure: dt() })),
  errors: [404],
});
```

Then run `npm run docs:openapi` to refresh `docs/openapi.json` for the frontend team. The interactive docs at
`/docs` update by themselves.

## 7. Test it (`tests/`)

Tests call the API like the frontend does. Add a case to the matching file (here `tests/board-alerts.test.js`
or a new file):

```js
it('lists the stays of a room, newest first', async () => {
  const fd = await as('front_desk'); // signed-in staff client for a role
  await fd.post('/admin/stays').send({ guest: { firstName: 'Ada' }, roomId: hotel.rooms[0].id, arrival: inHours(1), departure: inHours(24) });

  const res = await fd.get(`/admin/rooms/${hotel.rooms[0].id}/stays`).expect(200);
  expect(res.body.data).toHaveLength(1);
  expect(res.body.data[0]).toMatchObject({ status: 'reserved', guest: 'Ada' });

  const service = await as('service'); // a role without stays:read
  await service.get(`/admin/rooms/${hotel.rooms[0].id}/stays`).expect(403);
});
```

Also add the endpoint to the `ENDPOINTS` list in `tests/permissions.test.js`. That test calls it as every role
and checks that exactly the roles with the permission get in:

```js
['get', '/admin/rooms/1/stays', 'stays:read'],
```

Run the tests with `npm test`. They use the separate `DB_NAME_TEST` database, which is emptied before each test.

## Checklist

- [ ] Model function in `src/models/` (SQL only)
- [ ] Service function in `src/services/` (rules, errors, transaction, events)
- [ ] Controller in `src/controllers/` (`req.valid` → service → `res.json`)
- [ ] Validator in `src/validators/` (every body, query and path value)
- [ ] Route in `src/routes/` with `authorize(...)` and `validate(...)`
- [ ] `op(...)` in `src/docs/openapi.js`, then `npm run docs:openapi`
- [ ] Test in `tests/`, a line in `ENDPOINTS` in `tests/permissions.test.js` (admin routes), and `npm test` passes

## Where things are

| I want to... | Look in |
|---|---|
| Change who can call an endpoint | `src/config/permissions.js` |
| Change a database table | Add a migration in `db/migrations/` (`npx knex migrate:make name`), then `npm run migrate` |
| Send a live update to screens | Publish an event in the service; handle it in `src/realtime/listeners.js` |
| Send an email or push | `src/services/notification.service.js` |
| Talk to a lock, device hub or PMS | `src/integrations/devices/` or `src/integrations/pms/` |
| Run something on a schedule | `src/jobs/index.js` |
| Add a hotel-wide setting | Default in `src/services/settings.service.js`, allowed values in `src/validators/settings.validator.js` |
