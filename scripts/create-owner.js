// Run once on your own computer or server: npm run owner -- "Your Name"
// Prints your master key ONCE. Save it somewhere safe. It is stored hashed and can't be recovered.
const { Pool } = require('pg'); const crypto = require('crypto');
const name = process.argv[2];
if (!name || !process.env.DATABASE_URL) { console.error('Usage: DATABASE_URL=... npm run owner -- "Your Name"'); process.exit(1); }
(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const key = 'ttc_' + crypto.randomBytes(20).toString('hex');
  await db.query(`INSERT INTO users(name, role, key_hash, agreed_at) VALUES($1, 'owner', $2, NOW())`, [name, crypto.createHash('sha256').update(key).digest('hex')]);
  console.log(`\nMaster key for ${name}:\n\n  ${key}\n\nShown once. Never share it. Create editors and hub leads from /desk.html instead.\n`);
  await db.end();
})().catch(e => { console.error(e.message); process.exit(1); });
