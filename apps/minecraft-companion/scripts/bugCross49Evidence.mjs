import Database from 'better-sqlite3';

const [dbPath, token = 'BUGCROSS49'] = process.argv.slice(2);
if (!dbPath) throw new Error('usage: node scripts/bugCross49Evidence.mjs <db-path> [token]');

const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(`
  SELECT type, ts, payload_json
  FROM events
  WHERE payload_json LIKE ?
     OR type IN ('chat.from_owner', 'l7.turn_started', 'speech.committed')
  ORDER BY ts DESC
  LIMIT 100
`).all(`%${token}%`);

const relevant = rows.filter(row => {
  if (String(row.payload_json ?? '').includes(token)) return true;
  if (row.type === 'speech.committed') {
    try { return JSON.stringify(JSON.parse(row.payload_json ?? '{}')).includes('ACK49'); }
    catch { return false; }
  }
  return false;
});

console.log(JSON.stringify({
  token,
  eventTypes: relevant.map(row => row.type),
  counts: Object.fromEntries([...new Set(relevant.map(row => row.type))]
    .map(type => [type, relevant.filter(row => row.type === type).length])),
  timestamps: relevant.map(row => row.ts),
}, null, 2));
db.close();
