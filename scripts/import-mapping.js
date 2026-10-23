/**
 * Loads the hotel's room, floor and device mapping from a CSV file.
 *
 *   node scripts/import-mapping.js mapping.csv [--merge]
 *
 * Columns: room, floor, floor_name, room_type, adapter, adapter_vendor, device_type, external_id, device_name, capabilities
 * capabilities is optional JSON, e.g. {"dimmable":true} or {"inputs":["tv","hdmi1"]}.
 * One row per device. A room with no devices can have empty device columns.
 * Without --merge the file replaces the whole mapping (rooms not in the file are deactivated).
 * With --merge the file is added to the current mapping.
 */
import { readCsv, scriptActor, run } from './_util.js';
import { getMapping, putMapping } from '../src/modules/rooms/mapping.service.js';

const [file, flag] = process.argv.slice(2);

run(async () => {
  const rows = readCsv(file);
  const floors = new Map();
  const roomTypes = new Set();
  const adapters = new Map();
  const rooms = new Map();

  if (flag === '--merge') {
    const current = await getMapping();
    current.floors.forEach((f) => floors.set(f.number, { number: f.number, name: f.name ?? undefined }));
    current.roomTypes.forEach((t) => roomTypes.add(t));
    current.rooms.forEach((r) => rooms.set(r.number, { number: r.number, floor: r.floor, roomType: r.roomType ?? undefined, isActive: r.isActive, devices: r.devices.map((d) => ({ adapter: d.adapter, externalId: d.externalId, type: d.type, name: d.name ?? undefined })) }));
  }

  for (const [i, r] of rows.entries()) {
    const line = i + 2;
    if (!r.room || r.floor === undefined || r.floor === '') throw new Error(`Line ${line}: room and floor are required`);
    const floor = Number(r.floor);
    if (!Number.isInteger(floor)) throw new Error(`Line ${line}: floor must be a whole number`);
    floors.set(floor, { number: floor, name: r.floor_name || floors.get(floor)?.name });
    if (r.room_type) roomTypes.add(r.room_type);
    const room = rooms.get(r.room) || { number: r.room, floor, roomType: r.room_type || undefined, devices: [] };
    room.floor = floor;
    if (r.room_type) room.roomType = r.room_type;
    if (r.external_id) {
      if (!r.adapter || !r.device_type) throw new Error(`Line ${line}: adapter and device_type are required when external_id is set`);
      if (r.adapter_vendor) adapters.set(r.adapter, { name: r.adapter, vendor: r.adapter_vendor });
      room.devices = room.devices.filter((d) => !(d.adapter === r.adapter && d.externalId === r.external_id));
      let capabilities;
      if (r.capabilities) {
        try {
          capabilities = JSON.parse(r.capabilities);
        } catch {
          throw new Error(`Line ${line}: capabilities must be JSON, e.g. {"dimmable":true}`);
        }
      }
      room.devices.push({ adapter: r.adapter, externalId: r.external_id, type: r.device_type, name: r.device_name || undefined, ...(capabilities ? { capabilities } : {}) });
    }
    rooms.set(r.room, room);
  }

  const result = await putMapping(
    { floors: [...floors.values()], roomTypes: [...roomTypes], adapters: [...adapters.values()], rooms: [...rooms.values()] },
    await scriptActor(),
  );
  console.log('Mapping imported:', result.summary);
  result.warnings.forEach((w) => console.warn('Warning:', w));
});
