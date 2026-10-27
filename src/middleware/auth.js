import { unauthorized, forbidden } from '../utils/errors.js';
import { can } from '../config/permissions.js';
import { resolveAccessToken } from '../services/auth.service.js';
import { resolveGuestToken } from '../services/guestAuth.service.js';

const bearerToken = (req) => {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
};

/** Staff routes: requires "Authorization: Bearer <staff access token>" and sets req.staff. */
export async function authenticate(req, res, next) {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  req.staff = await resolveAccessToken(token);
  next();
}

/**
 * Staff routes: the signed-in staff member's role must have this permission.
 * The permission list is in src/config/permissions.js.
 *
 *   router.get('/', authorize('requests:read'), controller.list)
 */
export const authorize = (permission) => (req, res, next) => {
  if (!req.staff) throw unauthorized();
  if (!can(req.staff.role, permission)) throw forbidden();
  next();
};

/** Guest app routes: requires "Authorization: Bearer <guest token>" and sets req.guest. */
export async function authenticateGuest(req, res, next) {
  const token = bearerToken(req);
  if (!token) throw unauthorized();
  req.guest = await resolveGuestToken(token);
  next();
}
