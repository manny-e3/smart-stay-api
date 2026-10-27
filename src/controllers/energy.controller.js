import { stringify } from 'csv-stringify';
import * as energyService from '../services/energy.service.js';

/** GET /admin/energy */
export async function get(req, res) {
  res.json({ success: true, data: await energyService.getEnergy(req.valid.query) });
}

/** GET /admin/energy/export: a CSV download */
export async function exportCsv(req, res) {
  const { filename, columns, rows } = await energyService.getEnergyExport(req.valid.query);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const csv = stringify({ header: true, columns });
  csv.pipe(res);
  for (const row of rows) csv.write(row);
  csv.end();
  await new Promise((resolve, reject) => {
    res.on('finish', resolve);
    res.on('error', reject);
  });
}
