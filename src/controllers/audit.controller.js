import { searchAudit } from '../services/audit.service.js';

/** GET /admin/audit */
export async function search(req, res) {
  res.json({ success: true, data: await searchAudit(req.valid.query) });
}
