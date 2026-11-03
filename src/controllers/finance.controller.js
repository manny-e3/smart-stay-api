import * as financeService from '../services/finance.service.js';

const staffId = (req) => req.staff?.id;

/** GET /admin/finance/folios?status=open|settled|all */
export async function listFolios(req, res) {
  res.json({ success: true, data: await financeService.listFolios(req.query) });
}

/** GET /admin/finance/folios/:id */
export async function getFolio(req, res) {
  res.json({ success: true, data: await financeService.getFolio(req.params.id) });
}

/** POST /admin/finance/folios/:id/charge */
export async function postCharge(req, res) {
  const { folio, totalCharge } = await financeService.postCharge(req.params.id, req.body, staffId(req));
  res.json({ success: true, message: `Charge of $${totalCharge.toFixed(2)} posted to Folio ${folio.folio_number}` });
}

/** POST /admin/finance/folios/:id/settle */
export async function settle(req, res) {
  const { folio, payAmount } = await financeService.settle(req.params.id, req.body, staffId(req));
  res.json({ success: true, message: `Folio ${folio.folio_number} settled with payment of $${payAmount.toFixed(2)}` });
}

/** GET /admin/finance/reports/manager-daily */
export async function managerDaily(req, res) {
  res.json({ success: true, data: await financeService.managerDailyReport() });
}
