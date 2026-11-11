// If you lose your master key: DATABASE_URL=... npm run recover -- rec_xxxxxxxx
// Needs the recovery code you saved earlier from the desk. Issues a NEW master key; the old key and the code stop working.
const { Pool } = require('pg'); const crypto = require('crypto');
const code = process.argv[2];
if (!code || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=... npm run recover -- <recovery code>'); process.exit(1); }
const h = x => crypto.createHash('sha256').update(x).digest('hex');
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const key = 'ttc_' + crypto.randomBytes(20).toString('hex');
  const r = await db.query(`UPDATE users SET key_hash=$2, recovery_hash=NULL, active=TRUE, frozen=FALSE WHERE role='owner' AND recovery_hash=$1 RETURNING name`, [h(code), h(key)]);
  if (!r.rowCount) { console.error('That recovery code is not valid.'); process.exit(1); }
  console.log(`\nNew master key for ${r.rows[0].name}:\n\n  ${key}\n\nShown once. Create a fresh recovery code from the desk.\n`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
