import * as settingsService from '../services/settings.service.js';

/** GET /admin/settings */
export async function get(req, res) {
  res.json({ success: true, data: await settingsService.getSettings() });
}

/** PUT /admin/settings */
export async function update(req, res) {
  const data = await settingsService.updateSettings(req.valid.body, { staffId: req.staff.id, ip: req.ip });
  res.json({ success: true, data });
}
