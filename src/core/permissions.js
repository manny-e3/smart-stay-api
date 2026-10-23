export const ROLES = ['service', 'maintenance', 'front_desk', 'manager', 'admin'];

/** Single source of truth for which roles can do what. Routes and tests both read it. */
export const PERMISSIONS = {
  'board:read': ROLES,
  'requests:read': ['service', 'manager', 'admin'],
  'requests:write': ['service', 'manager', 'admin'],
  'alerts:read': ['maintenance', 'manager', 'admin'],
  'alerts:resolve': ['maintenance', 'manager', 'admin'],
  'feedback:read': ['manager', 'admin'],
  'staff:manage': ['admin'],
  'settings:manage': ['admin'],
  'mapping:manage': ['admin'],
  'audit:read': ['manager', 'admin'],
  'rules:manage': ['admin'],
  'energy:read': ['manager', 'admin'],
  // Guests and bookings
  'stays:read': ['front_desk', 'manager', 'admin'],
  'stays:write': ['front_desk', 'manager', 'admin'],
  'guests:anonymize': ['admin'],
  'pms:manage': ['admin'],
};

export const can = (role, permission) => PERMISSIONS[permission]?.includes(role) ?? false;
export const rolesFor = (permission) => PERMISSIONS[permission] ?? [];
