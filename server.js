const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const E = process.env;
if (!E.DATABASE_URL) throw new Error('Set DATABASE_URL (see .env.example)');

const db = new Pool({ connectionString: E.DATABASE_URL });
const PRICE = Number(E.AD_PRICE_KES || 600), DAYS = Number(E.AD_DAYS || 14);
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); next(); });
app.use('/api/', rateLimit({ windowMs: 60_000, max: 120 }));
const strict = rateLimit({ windowMs: 60_000, max: 5 });

const fail = (res, code, msg) => res.status(code).json({ error: msg });
const hash = k => crypto.createHash('sha256').update(k).digest('hex');
const newKey = () => 'ttc_' + crypto.randomBytes(20).toString('hex');
const RANK = { journalist: 1, hub_lead: 2, editor: 3, owner: 4 };
const auth = async (req, res, next) => {
  const k = req.get('x-api-key') || '';
  const u = k && (await db.query('SELECT u.id, u.name, u.role, u.hub_id, u.sub_county_id, u.agreed_at FROM users u LEFT JOIN hubs h ON h.id=u.hub_id WHERE u.key_hash=$1 AND u.active AND NOT u.frozen AND NOT COALESCE(h.frozen, FALSE)', [hash(k)])).rows[0];
  if (!u) return fail(res, 401, 'Unauthorized');
  db.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]).catch(() => {});
  req.user = u; next();
};
const need = (...roles) => [auth, (req, res, next) => roles.includes(req.user.role) ? next() : fail(res, 403, 'Not allowed for your role')];
const admin = need('owner', 'editor');
const log = (u, action, target, detail) => db.query('INSERT INTO audit(actor_id,action,target,detail) VALUES($1,$2,$3,$4)', [u.id, action, target || null, detail || null]).catch(() => {});
const subId = async slug => (await db.query('SELECT id FROM sub_counties WHERE slug=$1', [String(slug).toLowerCase()])).rows[0]?.id;
const track = (kind, ref, sub) => db.query('INSERT INTO events(kind,ref,sub_county_id) VALUES($1,$2,$3)', [kind, ref, sub || null]).catch(() => {});

// Feed: approved stories only, filtered by sub-county, paper and topic
app.get('/api/feed/:slug', async (req, res) => {
  try {
    const sid = await subId(req.params.slug);
    if (!sid) return fail(res, 404, 'Unknown sub-county');
    const { paper, topic } = req.query;
    const [stories, prices, merchants] = await Promise.all([
      db.query(`SELECT (SELECT json_build_object('id', p.id, 'headline', p.headline, 'bullets', p.bullets, 'paper', p.paper, 'topic', p.topic, 'image_url', p.image_url, 'video_url', p.video_url, 'reporter', pu.name)
        FROM stories p LEFT JOIN users pu ON pu.id=p.author_id WHERE p.id=s.pair_id AND p.status='approved') AS pair, s.paper, (s.body IS NOT NULL) AS has_body, s.id, s.headline, s.bullets, s.image_url, s.video_url, s.topic, s.placement, s.created_at, (s.breaking AND s.approved_at > NOW() - INTERVAL '24 hours') AS breaking, c.name AS reporter, (SELECT json_agg(json_build_object('note', x.note, 'at', x.created_at) ORDER BY x.created_at DESC) FROM corrections x WHERE x.story_id=s.id) AS corrections
                FROM stories s LEFT JOIN contributors c ON c.id = s.contributor_id
                WHERE s.status='approved' AND s.sub_county_id=$1
                  AND ($2::text IS NULL OR s.paper IN ($2,'both')) AND ($3::text IS NULL OR s.topic=$3)
                ORDER BY s.created_at DESC LIMIT 20`, [sid, paper || null, topic || null]),
      db.query('SELECT commodity, local_price, benchmark_price, updated_at FROM market_prices WHERE sub_county_id=$1 AND updated_at > NOW() - make_interval(days => 7) ORDER BY commodity', [sid]),
      db.query(`SELECT id, business_name, tagline, whatsapp, category, latitude, longitude, (verified_at IS NOT NULL AND badge_paid_until > NOW()) AS verified FROM merchants
                WHERE sub_county_id=$1 AND status='ACTIVE' AND expires_at > NOW()`, [sid])]);
    track('page_view', topic || 'latest', sid);
    res.set('Cache-Control', 'public, max-age=60').json({ stories: stories.rows, prices: prices.rows, merchants: merchants.rows });
  } catch (e) { console.error(e); fail(res, 500, 'Could not load feed'); }
});

// Stories, desk and people. Every level can only create and switch off the level below it.
const CENTRES = { voi: [-3.3961, 38.5561], taveta: [-3.3980, 37.6760], mwatate: [-3.5040, 38.3770], wundanyi: [-3.4020, 38.3680] };  // approximate town centres, used when no pin is given
const inCounty = (la, lo) => la >= -4.5 && la <= -2.4 && lo >= 37.3 && lo <= 39.6;
const staffOnly = u => ['owner', 'editor'].includes(u.role);
const load = async id => (await db.query('SELECT id, hub_id, placement, status FROM stories WHERE id=$1', [id])).rows[0];
const touch = (u, s) => staffOnly(u) || (u.role === 'hub_lead' && s.hub_id === u.hub_id);

app.get('/api/desk/me', auth, (req, res) => res.json({ ...req.user, agreed: !!req.user.agreed_at }));
app.post('/api/desk/agree', auth, async (req, res) => {
  await db.query('UPDATE users SET agreed_at=COALESCE(agreed_at,NOW()) WHERE id=$1', [req.user.id]); log(req.user, 'agreed'); res.json({ ok: true });
});

app.post('/api/bureau/stories', auth, async (req, res) => {
  const u = req.user;
  if (u.role !== 'owner' && !u.agreed_at) return fail(res, 403, 'Accept the contributor agreement first');
  try {
    const b = req.body || {}, restricted = ['journalist', 'hub_lead'].includes(u.role);
    const slug = restricted ? (await db.query('SELECT slug FROM sub_counties WHERE id=$1', [u.sub_county_id])).rows[0].slug : String(b.sub_county || '').toLowerCase();
    const sid = await subId(slug);
    const bullets = Array.isArray(b.bullets) ? b.bullets.map(x => String(x).trim()) : [];
    if (!sid || !String(b.headline || '').trim() || bullets.length !== 3 || bullets.some(x => !x || x.length > 160))
      return fail(res, 400, 'Need sub-county, headline and exactly 3 bullets (max 160 characters each)');
    let la = Number(b.latitude), lo = Number(b.longitude);
    if (!inCounty(la, lo)) [la, lo] = CENTRES[slug];
    const r = await db.query(
      `INSERT INTO stories(sub_county_id,author_id,hub_id,paper,topic,placement,headline,bullets,image_url,video_url,latitude,longitude,place_name,client_id,body)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (author_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING id`,
      [sid, u.id, u.hub_id, b.paper || 'both', b.topic || 'general', b.placement || 'daily', b.headline.trim().slice(0, 150), bullets,
       b.image_url || null, b.video_url || null, la, lo, String(b.place_name || '').slice(0, 80) || null, String(b.client_id || '').slice(0, 40) || null, String(b.body || '').trim().slice(0, 4000) || null]);
    if (!r.rows[0]) {                                               // same story sent twice (e.g. after a weak connection): don't duplicate
      const old = (await db.query('SELECT id FROM stories WHERE author_id=$1 AND client_id=$2', [u.id, String(b.client_id).slice(0, 40)])).rows[0];
      return res.json({ id: old?.id, status: 'draft', duplicate: true });
    }
    log(u, 'story_submitted', String(r.rows[0].id));
    if (u.role === 'journalist') pingHub(u.hub_id, `New draft: ${b.headline.trim().slice(0, 60)}. Open the desk to review.`);
    res.status(201).json({ id: r.rows[0].id, status: 'draft' });
  } catch (e) { console.error(e.message); fail(res, 400, 'Check the topic, paper and placement values'); }
});

app.get('/api/desk/stories', auth, async (req, res) => {
  const u = req.user; let where, params = [];
  if (u.role === 'journalist') { where = 's.author_id=$1'; params = [u.id]; }
  else if (u.role === 'hub_lead') { where = `s.hub_id=$1 AND s.status='draft'`; params = [u.hub_id]; }
  else where = `(s.status IN ('draft','ready') OR (s.status='approved' AND NOT s.fee_paid AND (s.fee_kes>0 OR (s.author_id IS NOT NULL AND s.approved_at > NOW() - INTERVAL '14 days'))))`;
  const r = await db.query(`SELECT s.id, s.headline, s.bullets, s.body, s.paper, s.topic, s.placement, s.status, s.fee_kes, s.fee_paid, s.latitude, s.longitude, s.place_name,
      sc.name AS sub_county, a.name AS reporter, a.mpesa_phone, h.name AS hub
    FROM stories s JOIN sub_counties sc ON sc.id=s.sub_county_id LEFT JOIN users a ON a.id=s.author_id LEFT JOIN hubs h ON h.id=s.hub_id
    WHERE ${where} ORDER BY s.created_at DESC LIMIT 50`, params);
  res.json(r.rows);
});
app.post('/api/desk/stories/:id/passup', need('hub_lead'), async (req, res) => {
  const s = await load(req.params.id);
  if (!s || !touch(req.user, s) || s.status !== 'draft') return fail(res, 404, 'Story not found');
  await db.query(`UPDATE stories SET status='ready' WHERE id=$1`, [s.id]); log(req.user, 'story_passed_up', String(s.id)); res.json({ ready: s.id });
});
app.post('/api/desk/stories/:id/approve', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const u = req.user, s = await load(req.params.id), lead = u.role === 'hub_lead';
  if (!s || !touch(u, s)) return fail(res, 404, 'Story not found');
  if (lead && !(s.placement === 'daily' && s.status === 'draft')) return fail(res, 403, 'Hub leads publish daily-feed drafts only. Pass main-issue stories to the editor.');
  const fee = lead ? 0 : Math.max(0, parseInt(req.body?.fee_kes, 10) || 0);
  const la = Number(req.body?.latitude), lo = Number(req.body?.longitude), ok = !lead && inCounty(la, lo);
  await db.query(`UPDATE stories SET status='approved', approved_at=NOW(), approved_by=$6, fee_kes=$2, latitude=COALESCE($3,latitude), longitude=COALESCE($4,longitude), breaking=$5, lead_at=CASE WHEN $7 THEN NOW() ELSE lead_at END WHERE id=$1`,
    [s.id, fee, ok ? la : null, ok ? lo : null, !lead && !!req.body?.breaking, u.id, !lead && !!req.body?.is_lead]);
  log(u, 'story_approved', String(s.id), `fee ${fee}`); res.json({ approved: s.id });
});
app.post('/api/desk/stories/:id/reject', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const s = await load(req.params.id);
  if (!s || !touch(req.user, s) || (req.user.role === 'hub_lead' && s.status !== 'draft')) return fail(res, 404, 'Story not found');
  await db.query(`UPDATE stories SET status='rejected' WHERE id=$1`, [s.id]); log(req.user, 'story_rejected', String(s.id)); res.json({ rejected: s.id });
});
app.post('/api/desk/stories/:id/fee', admin, async (req, res) => {
  const fee = Math.max(0, parseInt(req.body?.fee_kes, 10) || 0);
  const r = await db.query(`UPDATE stories SET fee_kes=$2 WHERE id=$1 AND status='approved' RETURNING id`, [req.params.id, fee]);
  if (!r.rowCount) return fail(res, 404, 'Story not found');
  log(req.user, 'fee_set', req.params.id, String(fee)); res.json({ fee });
});
app.post('/api/desk/stories/:id/paid', admin, async (req, res) => {
  const r = await db.query(`UPDATE stories SET fee_paid=TRUE WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Story not found');
  log(req.user, 'fee_paid', req.params.id); res.json({ paid: r.rows[0].id });
});

// People and hubs
const MAKES = { owner: ['editor', 'hub_lead', 'journalist'], editor: ['hub_lead', 'journalist'], hub_lead: ['journalist'] };
const manage = async (req, res) => {
  const t = (await db.query('SELECT id, name, role, hub_id FROM users WHERE id=$1', [req.params.id])).rows[0], u = req.user;
  if (!t) { fail(res, 404, 'No such person'); return null; }
  if (!(RANK[u.role] > RANK[t.role] && u.role !== 'journalist' && (u.role !== 'hub_lead' || t.hub_id === u.hub_id))) { fail(res, 403, 'Not allowed'); return null; }
  return t;
};
app.get('/api/desk/hubs', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const u = req.user;
  res.json((await db.query(`SELECT h.id, h.name, h.frozen, sc.name AS sub_county FROM hubs h JOIN sub_counties sc ON sc.id=h.sub_county_id WHERE h.active AND ($1::int IS NULL OR h.id=$1) ORDER BY h.name`, [u.role === 'hub_lead' ? u.hub_id : null])).rows);
});
app.post('/api/desk/hubs', admin, async (req, res) => {
  const sid = await subId(req.body?.sub_county || '');
  if (!sid || !String(req.body?.name || '').trim()) return fail(res, 400, 'Need a hub name and sub-county');
  const r = await db.query('INSERT INTO hubs(name, sub_county_id) VALUES($1,$2) RETURNING id', [req.body.name.trim().slice(0, 80), sid]);
  log(req.user, 'hub_created', String(r.rows[0].id), req.body.name); res.status(201).json({ id: r.rows[0].id });
});
app.get('/api/desk/users', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const u = req.user;
  res.json((await db.query(`SELECT x.id, x.name, x.role, x.active, x.frozen, x.hub_id, x.agreed_at, x.last_seen, h.name AS hub FROM users x LEFT JOIN hubs h ON h.id=x.hub_id
    WHERE x.role <> 'owner' AND ($1::int IS NULL OR x.hub_id=$1) ORDER BY h.name NULLS FIRST, x.role, x.name`, [u.role === 'hub_lead' ? u.hub_id : null])).rows);
});
app.post('/api/desk/users', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const u = req.user, b = req.body || {};
  if (!MAKES[u.role].includes(b.role)) return fail(res, 403, 'Your role cannot create that kind of account');
  if (!String(b.name || '').trim() || (b.mpesa_phone && !/^254[17]\d{8}$/.test(b.mpesa_phone))) return fail(res, 400, 'Need a name and, if given, an M-Pesa number like 2547XXXXXXXX');
  let hubId = null, sid = null;
  if (b.role !== 'editor') {
    hubId = u.role === 'hub_lead' ? u.hub_id : Number(b.hub_id);
    const h = (await db.query('SELECT id, sub_county_id FROM hubs WHERE id=$1 AND active', [hubId])).rows[0];
    if (!h) return fail(res, 400, 'Choose a hub');
    sid = h.sub_county_id;
  }
  const key = newKey();
  const r = await db.query(`INSERT INTO users(name,role,hub_id,sub_county_id,mpesa_phone,key_hash,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [b.name.trim().slice(0, 100), b.role, hubId, sid, b.mpesa_phone || null, hash(key), u.id]);
  log(u, 'user_created', String(r.rows[0].id), `${b.role}: ${b.name}`);
  res.status(201).json({ id: r.rows[0].id, key });          // shown once: send it privately
});
app.post('/api/desk/users/:id/reset-key', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const t = await manage(req, res); if (!t) return;
  const key = newKey(); await db.query('UPDATE users SET key_hash=$2, active=TRUE WHERE id=$1', [t.id, hash(key)]);
  log(req.user, 'key_reset', String(t.id), t.name); res.json({ key });
});
app.post('/api/desk/users/:id/deactivate', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const t = await manage(req, res); if (!t) return;
  await db.query('UPDATE users SET active=FALSE WHERE id=$1', [t.id]); log(req.user, 'user_switched_off', String(t.id), t.name); res.json({ off: t.id });
});
app.get('/api/desk/audit', need('owner'), async (req, res) =>
  res.json((await db.query(`SELECT a.created_at, u.name AS who, a.action, a.target, a.detail FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100`)).rows));

// ---- Phase 1: overrides, edits, corrections, uploads, listings
const fs = require('fs'), path = require('path');
const owner = need('owner');
const EDITABLE = ['headline', 'bullets', 'topic', 'placement', 'paper', 'image_url', 'video_url', 'place_name', 'latitude', 'longitude', 'body'];
const fullStory = async id => (await db.query(`SELECT id, hub_id, author_id, status, ${EDITABLE.join(', ')} FROM stories WHERE id=$1`, [id])).rows[0];

app.patch('/api/desk/stories/:id', auth, async (req, res) => {          // edit after submission; every change logged
  const u = req.user, s = await fullStory(req.params.id);
  const ok = s && (staffOnly(u) || (u.role === 'hub_lead' && s.hub_id === u.hub_id && ['draft', 'ready'].includes(s.status)) || (u.role === 'journalist' && s.author_id === u.id && s.status === 'draft'));
  if (!ok) return fail(res, 404, 'Story not found');
  const b = req.body || {}, before = {}, after = {};
  for (const k of EDITABLE) {
    if (b[k] === undefined) continue; let v = b[k];
    if (k === 'bullets') { v = Array.isArray(v) ? v.map(x => String(x).trim()) : []; if (v.length !== 3 || v.some(x => !x || x.length > 160)) return fail(res, 400, 'Exactly 3 points, max 160 characters each'); }
    else if (k === 'headline') { v = String(v).trim().slice(0, 150); if (!v) return fail(res, 400, 'Headline is required'); }
    else if (k === 'latitude' || k === 'longitude') v = Number(v);
    else if (k === 'body') v = String(v).trim().slice(0, 4000) || null;
    else v = v === '' ? null : String(v).slice(0, 255);
    const same = (k === 'latitude' || k === 'longitude') ? Number(s[k]) === v : JSON.stringify(v) === JSON.stringify(s[k]);
    if (!same) { before[k] = s[k]; after[k] = v; }
  }
  if (('latitude' in after || 'longitude' in after) && !inCounty(Number(b.latitude), Number(b.longitude))) return fail(res, 400, 'Location is outside the county');
  const keys = Object.keys(after), note = String(b.correction || '').trim().slice(0, 300);
  try {
    if (keys.length) {
      await db.query(`UPDATE stories SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE id=$1`, [s.id, ...keys.map(k => after[k])]);
      await db.query('INSERT INTO story_edits(story_id,editor_id,before,after) VALUES($1,$2,$3,$4)', [s.id, u.id, before, after]);
      log(u, 'story_edited', String(s.id), keys.join(','));
    }
    if (note && staffOnly(u) && s.status === 'approved') { await db.query('INSERT INTO corrections(story_id,note,created_by) VALUES($1,$2,$3)', [s.id, note, u.id]); log(u, 'correction_added', String(s.id)); }
    res.json({ changed: keys, correction: !!(note && staffOnly(u) && s.status === 'approved') });
  } catch (e) { fail(res, 400, 'Check the topic, paper and placement values'); }
});
app.get('/api/desk/published', admin, async (req, res) => {
  const q = `%${String(req.query.q || '').replace(/[%_]/g, '')}%`;
  res.json((await db.query(`SELECT s.id, s.pair_id, s.headline, s.bullets, s.body, s.topic, s.placement, s.paper, s.fee_kes, s.fee_paid, s.approved_at, a.name AS reporter, h.name AS hub,
      (SELECT COUNT(*)::int FROM corrections x WHERE x.story_id=s.id) AS corrections
    FROM stories s LEFT JOIN users a ON a.id=s.author_id LEFT JOIN hubs h ON h.id=s.hub_id
    WHERE s.status='approved' AND s.headline ILIKE $1 ORDER BY s.approved_at DESC NULLS LAST LIMIT 40`, [q])).rows);
});
app.post('/api/desk/stories/:id/unpublish', admin, async (req, res) => {
  const r = await db.query(`UPDATE stories SET status='draft', approved_at=NULL, breaking=FALSE WHERE id=$1 AND status='approved' RETURNING id`, [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Published story not found');
  log(req.user, 'story_unpublished', req.params.id); res.json({ unpublished: r.rows[0].id });
});
app.post('/api/desk/stories/:id/credit', owner, async (req, res) => {     // change who is credited and paid
  const t = (await db.query(`SELECT id, hub_id FROM users WHERE id=$1 AND role IN ('journalist','hub_lead') AND active`, [req.body?.author_id])).rows[0];
  if (!t) return fail(res, 400, 'Choose an active journalist or hub lead');
  const r = await db.query('UPDATE stories SET author_id=$2, hub_id=$3 WHERE id=$1 RETURNING id', [req.params.id, t.id, t.hub_id]);
  if (!r.rowCount) return fail(res, 404, 'Story not found');
  log(req.user, 'story_credit_changed', req.params.id, `to user ${t.id}`); res.json({ ok: true });
});

// Personnel overrides
app.post('/api/desk/hubs/:id/replace-lead', admin, async (req, res) => {   // A1: old lead out, new lead in, hub's people and stories stay
  const b = req.body || {}, h = (await db.query('SELECT id, sub_county_id FROM hubs WHERE id=$1 AND active', [req.params.id])).rows[0];
  if (!h || !String(b.name || '').trim() || (b.mpesa_phone && !/^254[17]\d{8}$/.test(b.mpesa_phone))) return fail(res, 400, 'Need a hub, a name and, if given, a valid M-Pesa number');
  await db.query(`UPDATE users SET active=FALSE WHERE hub_id=$1 AND role='hub_lead' AND active`, [h.id]);
  const key = newKey();
  const r = await db.query(`INSERT INTO users(name,role,hub_id,sub_county_id,mpesa_phone,key_hash,created_by) VALUES($1,'hub_lead',$2,$3,$4,$5,$6) RETURNING id`,
    [b.name.trim().slice(0, 100), h.id, h.sub_county_id, b.mpesa_phone || null, hash(key), req.user.id]);
  log(req.user, 'hub_lead_replaced', String(h.id), b.name); res.status(201).json({ id: r.rows[0].id, key });
});
app.post('/api/desk/users/:id/move', admin, async (req, res) => {          // A2
  const t = (await db.query('SELECT id, role FROM users WHERE id=$1', [req.params.id])).rows[0];
  const h = (await db.query('SELECT id, sub_county_id FROM hubs WHERE id=$1 AND active', [req.body?.hub_id])).rows[0];
  if (!t || !h || !['journalist', 'hub_lead'].includes(t.role)) return fail(res, 400, 'Choose a journalist or hub lead and an active hub');
  await db.query('UPDATE users SET hub_id=$2, sub_county_id=$3 WHERE id=$1', [t.id, h.id, h.sub_county_id]);
  await db.query(`UPDATE stories SET hub_id=$2 WHERE author_id=$1 AND status IN ('draft','ready')`, [t.id, h.id]);
  log(req.user, 'user_moved', String(t.id), `to hub ${h.id}`); res.json({ ok: true });
});
app.post('/api/desk/users/:id/freeze', owner, async (req, res) => {        // A4
  const r = await db.query(`UPDATE users SET frozen=$2 WHERE id=$1 AND role<>'owner' RETURNING id`, [req.params.id, !!req.body?.frozen]);
  if (!r.rowCount) return fail(res, 404, 'No such person'); log(req.user, req.body?.frozen ? 'user_frozen' : 'user_unfrozen', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/hubs/:id/freeze', owner, async (req, res) => {
  const r = await db.query('UPDATE hubs SET frozen=$2 WHERE id=$1 RETURNING id', [req.params.id, !!req.body?.frozen]);
  if (!r.rowCount) return fail(res, 404, 'No such hub'); log(req.user, req.body?.frozen ? 'hub_frozen' : 'hub_unfrozen', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/users/:id/handover', owner, async (req, res) => {      // A5: leaving editor's unpaid fees and created accounts go to another editor
  const from = (await db.query(`SELECT id FROM users WHERE id=$1 AND role='editor'`, [req.params.id])).rows[0];
  const to = (await db.query(`SELECT id FROM users WHERE id=$1 AND role='editor' AND active AND NOT frozen`, [req.body?.to_id])).rows[0];
  if (!from || !to || from.id === to.id) return fail(res, 400, 'Choose two different active editors');
  const s = await db.query('UPDATE stories SET approved_by=$2 WHERE approved_by=$1 AND NOT fee_paid', [from.id, to.id]);
  await db.query('UPDATE users SET created_by=$2 WHERE created_by=$1', [from.id, to.id]);
  if (req.body?.switch_off) await db.query('UPDATE users SET active=FALSE WHERE id=$1', [from.id]);
  log(req.user, 'editor_handover', String(from.id), `to ${to.id}, ${s.rowCount} stories`); res.json({ stories: s.rowCount });
});
app.post('/api/desk/recovery-code', owner, async (req, res) => {           // A6
  const code = 'rec_' + crypto.randomBytes(16).toString('hex');
  await db.query('UPDATE users SET recovery_hash=$2 WHERE id=$1', [req.user.id, hash(code)]); log(req.user, 'recovery_code_created'); res.json({ code });
});

// Photo upload (the app shrinks photos first, which also strips location data)
fs.mkdirSync('uploads', { recursive: true });
app.post('/api/upload', auth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), (req, res) => {
  const b = req.body;
  if (!Buffer.isBuffer(b) || b.length < 100) return fail(res, 400, 'Send an image under 2 MB');
  const ext = b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') ? 'webp' : null;
  if (!ext) return fail(res, 400, 'Only JPEG, PNG or WebP images');
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join('uploads', name), b); log(req.user, 'photo_uploaded', name);
  res.status(201).json({ url: '/media/' + name });
});
app.use('/media', express.static('uploads', { maxAge: '30d', index: false }));

// Edit and expire notices, prices, listings
app.get('/api/desk/notices', admin, async (req, res) => res.json((await db.query(
  `SELECT n.id, n.kind, n.title, n.body, n.lang, n.event_date, n.expires_on, n.created_at, sc.name AS area FROM notices n LEFT JOIN sub_counties sc ON sc.id=n.sub_county_id ORDER BY n.created_at DESC LIMIT 50`)).rows));
app.post('/api/desk/notices/:id/expire', admin, async (req, res) => {
  const r = await db.query('UPDATE notices SET expires_on=CURRENT_DATE - 1 WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Notice not found'); log(req.user, 'notice_expired', req.params.id); res.json({ ok: true });
});
app.patch('/api/desk/notices/:id', admin, async (req, res) => {
  const b = req.body || {};
  const r = await db.query(`UPDATE notices SET title=COALESCE(NULLIF($2,''),title), body=COALESCE(NULLIF($3,''),body), event_date=$4, expires_on=$5 WHERE id=$1 RETURNING id`,
    [req.params.id, String(b.title || '').slice(0, 150), String(b.body || '').slice(0, 4000), b.event_date || null, b.expires_on || null]);
  if (!r.rowCount) return fail(res, 404, 'Notice not found'); log(req.user, 'notice_edited', req.params.id); res.json({ ok: true });
});
app.get('/api/desk/prices', admin, async (req, res) => {
  const sid = await subId(req.query.sub_county || '');
  res.json(sid ? (await db.query('SELECT commodity, local_price, benchmark_price, updated_at FROM market_prices WHERE sub_county_id=$1', [sid])).rows : []);
});
app.get('/api/desk/merchants', admin, async (req, res) => res.json((await db.query(
  `SELECT m.id, m.business_name, m.category, m.status, m.expires_at, m.verified_at, m.badge_paid_until, m.report_token, sc.name AS area FROM merchants m JOIN sub_counties sc ON sc.id=m.sub_county_id ORDER BY m.created_at DESC LIMIT 50`)).rows));
app.post('/api/desk/merchants/:id/expire', admin, async (req, res) => {
  const r = await db.query(`UPDATE merchants SET status='EXPIRED', expires_at=NOW() WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Listing not found'); log(req.user, 'listing_expired', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/merchants/:id/extend', admin, async (req, res) => {
  const r = await db.query(`UPDATE merchants SET status='ACTIVE', expires_at=GREATEST(COALESCE(expires_at, NOW()), NOW()) + ($2 || ' days')::interval WHERE id=$1 AND status<>'PENDING' RETURNING id`, [req.params.id, DAYS]);
  if (!r.rowCount) return fail(res, 404, 'Listing not found'); log(req.user, 'listing_extended', req.params.id); res.json({ ok: true });
});

// ---- Phase 2: hub-lead pings and reader tips
const lastPing = new Map();
async function sms(to, message) {
  if (!E.SMS_KEY || !E.SMS_USER) return;
  const body = new URLSearchParams({ username: E.SMS_USER, to, message });
  if (E.SMS_FROM) body.set('from', E.SMS_FROM);
  await axios.post(E.SMS_URL || 'https://api.africastalking.com/version1/messaging', body, { headers: { apiKey: E.SMS_KEY, Accept: 'application/json' } });
}
async function pingHub(hubId, text) {                 // at most one SMS per hub lead every 10 minutes, to control cost
  if (!hubId) return;
  const leads = (await db.query(`SELECT id, mpesa_phone FROM users WHERE hub_id=$1 AND role='hub_lead' AND active AND NOT frozen AND mpesa_phone IS NOT NULL`, [hubId])).rows;
  for (const l of leads) {
    if (Date.now() - (lastPing.get(l.id) || 0) < 600000) continue;
    lastPing.set(l.id, Date.now()); sms('+' + l.mpesa_phone, text.slice(0, 140)).catch(e => console.error('sms', e.message));
  }
}
function imgExt(b) { return b[0] === 0xff && b[1] === 0xd8 ? 'jpg' : b[0] === 0x89 && b[1] === 0x50 ? 'png' : (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') ? 'webp' : null; }
function saveImg(b, ext) { const name = crypto.randomBytes(12).toString('hex') + '.' + ext; fs.writeFileSync(path.join('uploads', name), b); return '/media/' + name; }
const whoHash = s => crypto.createHash('sha256').update(String(s) + (E.WA_APP_SECRET || 'salt')).digest('hex').slice(0, 24);
async function createTip({ text, slug, contact, place, lat, lon, source, who, kind = 'tip' }) {
  text = String(text || '').trim();
  if (text.length < 15 || text.length > 1000 || (text.match(/https?:\/\//gi) || []).length > 1) return { error: 'Please describe what happened in 15 to 1000 characters, with no more than one link.' };
  const day = (await db.query(`SELECT COUNT(*)::int AS n FROM tips WHERE who_hash=$1 AND created_at > NOW() - INTERVAL '1 day'`, [who])).rows[0].n;
  if (day >= 5) return { error: 'Daily tip limit reached. Thank you. Please try again tomorrow.' };
  const sid = slug ? await subId(slug) : null;
  const hub = sid ? (await db.query('SELECT id FROM hubs WHERE sub_county_id=$1 AND active ORDER BY id LIMIT 1', [sid])).rows[0] : null;
  const token = crypto.randomBytes(16).toString('hex');
  const r = await db.query(`INSERT INTO tips(sub_county_id,hub_id,body,contact,place_name,latitude,longitude,source,who_hash,photo_token_hash,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [sid, hub?.id || null, text, contact || null, String(place || '').slice(0, 80) || null, inCounty(lat, lon) ? lat : null, inCounty(lat, lon) ? lon : null, source, who, hash(token), kind]);
  pingHub(hub?.id, `New reader ${kind === 'claim' ? 'claim to check' : 'tip'} (${source}). Open the desk, Tips tab.`);
  return { id: r.rows[0].id, token };
}
const tipLimit = rateLimit({ windowMs: 60000, max: 4 });
app.post('/api/tips', tipLimit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });                       // honeypot: bots fill hidden fields
  const contact = /^254[17]\d{8}$/.test(b.contact || '') ? b.contact : null;
  const r = await createTip({ text: b.text, slug: b.sub_county, contact, place: b.place_name, lat: Number(b.latitude), lon: Number(b.longitude), source: 'app', who: whoHash(req.ip), kind: b.kind === 'claim' ? 'claim' : 'tip' });
  r.error ? fail(res, 400, r.error) : res.status(201).json(r);
});
app.post('/api/tips/:id/photo', tipLimit, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1500kb' }), async (req, res) => {
  const b = req.body, t = (await db.query('SELECT id FROM tips WHERE id=$1 AND photo_token_hash=$2 AND image_url IS NULL', [req.params.id, hash(req.get('x-tip-token') || '')])).rows[0];
  if (!t || !Buffer.isBuffer(b) || b.length < 100 || !imgExt(b)) return fail(res, 400, 'Photo not accepted');
  await db.query('UPDATE tips SET image_url=$2, photo_token_hash=NULL WHERE id=$1', [t.id, saveImg(b, imgExt(b))]); res.json({ ok: true });
});
app.get('/api/desk/tips', auth, async (req, res) => {
  const u = req.user; let where, params = [];
  if (u.role === 'journalist') { where = `t.assigned_to=$1 AND t.status='assigned'`; params = [u.id]; }
  else if (u.role === 'hub_lead') { where = `t.hub_id=$1 AND t.status IN ('new','assigned')`; params = [u.hub_id]; }
  else where = `t.status IN ('new','assigned')`;
  res.json((await db.query(`SELECT t.id, t.kind, t.body, t.image_url, t.place_name, t.source, t.status, t.created_at, ${u.role === 'journalist' ? 'NULL' : 't.contact'} AS contact, sc.name AS sub_county, a.name AS assigned
    FROM tips t LEFT JOIN sub_counties sc ON sc.id=t.sub_county_id LEFT JOIN users a ON a.id=t.assigned_to WHERE ${where} ORDER BY t.created_at DESC LIMIT 50`, params)).rows);
});
const tipFor = async (req, res) => {
  const t = (await db.query('SELECT id, hub_id, assigned_to FROM tips WHERE id=$1', [req.params.id])).rows[0], u = req.user;
  if (!t || !(staffOnly(u) || (u.role === 'hub_lead' && t.hub_id === u.hub_id) || (u.role === 'journalist' && t.assigned_to === u.id))) { fail(res, 404, 'Tip not found'); return null; }
  return t;
};
app.post('/api/desk/tips/:id/assign', need('owner', 'editor', 'hub_lead'), async (req, res) => {
  const t = await tipFor(req, res); if (!t) return;
  const j = (await db.query(`SELECT id FROM users WHERE id=$1 AND role='journalist' AND active AND ($2::int IS NULL OR hub_id=$2)`, [req.body?.user_id, req.user.role === 'hub_lead' ? req.user.hub_id : null])).rows[0];
  if (!j) return fail(res, 400, 'Choose an active journalist in the hub');
  await db.query(`UPDATE tips SET assigned_to=$2, status='assigned' WHERE id=$1`, [t.id, j.id]); log(req.user, 'tip_assigned', String(t.id), `to ${j.id}`); res.json({ ok: true });
});
app.post('/api/desk/tips/:id/status', auth, async (req, res) => {
  const t = await tipFor(req, res); if (!t) return;
  const st = req.body?.status;
  if (!['used', 'spam', 'new'].includes(st) || (req.user.role === 'journalist' && st !== 'used')) return fail(res, 400, 'Not allowed');
  await db.query('UPDATE tips SET status=$2 WHERE id=$1', [t.id, st]); log(req.user, 'tip_' + st, String(t.id)); res.json({ ok: true });
});
async function waImage(m) {
  const t = (await db.query(`SELECT id FROM tips WHERE contact=$1 AND image_url IS NULL AND created_at > NOW() - INTERVAL '10 minutes' ORDER BY id DESC LIMIT 1`, [m.from])).rows[0];
  if (!t) return 'To send a tip, first message TIP followed by what happened. Then send the photo.';
  const H = { Authorization: `Bearer ${E.WA_TOKEN}` };
  const meta = await axios.get(`https://graph.facebook.com/v20.0/${m.image.id}`, { headers: H });
  const img = await axios.get(meta.data.url, { headers: H, responseType: 'arraybuffer', maxContentLength: 3e6 });
  const b = Buffer.from(img.data), ext = imgExt(b);
  if (!ext) return 'Sorry, we can only accept JPEG, PNG or WebP photos.';
  await db.query('UPDATE tips SET image_url=$2 WHERE id=$1', [t.id, saveImg(b, ext)]); return 'Photo received. Thank you!';
}

// ---- Phase 3: paired stories and votes, fact-checks, results, markets and traders, sport
const DAYSET = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const areaOk = (u, sid) => u.role !== 'hub_lead' || u.sub_county_id === sid;
const scopeSid = async (req, slug) => req.user.role === 'hub_lead' ? req.user.sub_county_id : await subId(slug || '');
const crew = need('owner', 'editor', 'hub_lead');

app.post('/api/desk/stories/:id/pair', admin, async (req, res) => {       // H1: link a story with its rebuttal
  const id = Number(req.params.id), w = req.body?.with_id == null ? null : Number(req.body.with_id);
  if (w !== null) {
    const n = (await db.query(`SELECT COUNT(*)::int AS n FROM stories WHERE id = ANY($1) AND status='approved'`, [[id, w]])).rows[0].n;
    if (w === id || n !== 2) return fail(res, 400, 'Choose a different published story');
  }
  await db.query('UPDATE stories SET pair_id=NULL WHERE id = ANY($1) OR pair_id = ANY($1)', [[id, w].filter(Boolean)]);
  if (w !== null) await db.query('UPDATE stories SET pair_id = CASE id WHEN $1 THEN $2 ELSE $1 END WHERE id IN ($1, $2)', [id, w]);
  log(req.user, w === null ? 'story_unpaired' : 'story_paired', String(id), w ? `with ${w}` : ''); res.json({ ok: true });
});
const voteLimit = rateLimit({ windowMs: 60000, max: 20 });
app.post('/api/vote', voteLimit, async (req, res) => {                      // H2: one vote per device per pair (a casual poll, not tamper-proof)
  const sid = Number(req.body?.story_id), dev = String(req.body?.device || '').slice(0, 60);
  const s = sid && dev.length >= 8 && (await db.query(`SELECT id, pair_id FROM stories WHERE id=$1 AND status='approved' AND pair_id IS NOT NULL`, [sid])).rows[0];
  if (!s) return fail(res, 400, 'Vote not accepted');
  const key = Math.min(s.id, s.pair_id);
  const r = await db.query('INSERT INTO votes(pair_key,story_id,who_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [key, s.id, whoHash(dev)]);
  const c = (await db.query('SELECT story_id, COUNT(*)::int AS n FROM votes WHERE pair_key=$1 GROUP BY story_id', [key])).rows;
  res.json({ counted: !!r.rowCount, votes: Object.fromEntries(c.map(x => [x.story_id, x.n])) });
});
app.get('/api/votes/week', async (req, res) => {
  const r = await db.query(`SELECT s.headline, s.paper, COUNT(*)::int AS votes FROM votes v JOIN stories s ON s.id=v.story_id
    WHERE v.created_at > NOW() - INTERVAL '7 days' GROUP BY s.id ORDER BY votes DESC LIMIT 1`);
  res.json(r.rows[0] || {});
});
app.post('/api/desk/tips/:id/factcheck', admin, async (req, res) => {        // G2: publish a verified answer
  const VERD = { true: 'TRUE', false: 'FALSE', misleading: 'MISLEADING', unverified: 'NOT VERIFIED' }, b = req.body || {};
  const verdict = VERD[b.verdict], answer = String(b.answer || '').trim();
  const t = (await db.query(`SELECT id, body, sub_county_id FROM tips WHERE id=$1 AND kind='claim'`, [req.params.id])).rows[0];
  if (!t || !verdict || answer.length < 10) return fail(res, 400, 'Choose a verdict and write the answer (at least 10 characters)');
  const r = await db.query(`INSERT INTO notices(kind,sub_county_id,lang,title,body) VALUES('factcheck',$1,'en',$2,$3) RETURNING id`, [t.sub_county_id, t.body.slice(0, 150), `${verdict}. ${answer.slice(0, 3500)}`]);
  await db.query(`UPDATE tips SET status='used' WHERE id=$1`, [t.id]); log(req.user, 'factcheck_published', String(t.id)); res.status(201).json({ id: r.rows[0].id });
});

// G4: school averages only (individual results are children's personal data; they stay with official channels)
app.get('/api/results', async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  const q = req.query.q ? `%${String(req.query.q).replace(/[%_]/g, '')}%` : null;
  res.json((await db.query(`SELECT school, exam, year, candidates, mean_score, mean_grade FROM school_results
    WHERE ($1::int IS NULL OR sub_county_id=$1) AND ($2::text IS NULL OR exam=$2) AND ($3::int IS NULL OR year=$3) AND ($4::text IS NULL OR school ILIKE $4)
    ORDER BY year DESC, mean_score DESC NULLS LAST LIMIT 100`, [sid, req.query.exam || null, Number(req.query.year) || null, q])).rows);
});
app.post('/api/desk/results', admin, async (req, res) => {
  const b = req.body || {}, sid = await subId(b.sub_county || ''), year = parseInt(b.year, 10);
  const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 300).filter(r => String(r.school || '').trim());
  if (!sid || !['KCPE', 'KCSE'].includes(b.exam) || !(year > 2000 && year < 2100) || !rows.length) return fail(res, 400, 'Need exam, year, area and at least one school');
  await db.query('DELETE FROM school_results WHERE exam=$1 AND year=$2 AND sub_county_id=$3', [b.exam, year, sid]);
  for (const r of rows) await db.query('INSERT INTO school_results(exam,year,sub_county_id,school,candidates,mean_score,mean_grade) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [b.exam, year, sid, String(r.school).trim().slice(0, 120), parseInt(r.candidates, 10) || null, Number(r.mean_score) || null, String(r.mean_grade || '').slice(0, 3) || null]);
  log(req.user, 'results_imported', `${b.exam} ${year}`, `${rows.length} schools`); res.json({ saved: rows.length });
});

// G5: market days and trader directory
app.get('/api/markets', async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  const [markets, traders] = await Promise.all([
    db.query('SELECT id, name, days, notes FROM markets WHERE active AND ($1::int IS NULL OR sub_county_id=$1) ORDER BY name', [sid]),
    db.query(`SELECT t.id, t.name, t.goods, t.whatsapp, m.name AS market FROM traders t LEFT JOIN markets m ON m.id=t.market_id WHERE t.active AND ($1::int IS NULL OR t.sub_county_id=$1) ORDER BY t.name`, [sid])]);
  res.json({ markets: markets.rows, traders: traders.rows });
});
app.post('/api/desk/markets', crew, async (req, res) => {
  const b = req.body || {}, sid = await scopeSid(req, b.sub_county), days = (b.days || []).filter(d => DAYSET.includes(d));
  if (!sid || !String(b.name || '').trim() || !days.length) return fail(res, 400, 'Need a market name, area and at least one day');
  const r = await db.query('INSERT INTO markets(name,sub_county_id,days,notes) VALUES($1,$2,$3,$4) RETURNING id', [b.name.trim().slice(0, 80), sid, days, String(b.notes || '').slice(0, 200) || null]);
  log(req.user, 'market_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/markets/:id/delete', crew, async (req, res) => {
  const m = (await db.query('SELECT sub_county_id FROM markets WHERE id=$1', [req.params.id])).rows[0];
  if (!m || !areaOk(req.user, m.sub_county_id)) return fail(res, 404, 'Market not found');
  await db.query('UPDATE markets SET active=FALSE WHERE id=$1', [req.params.id]); log(req.user, 'market_removed', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/traders', crew, async (req, res) => {
  const b = req.body || {}, sid = await scopeSid(req, b.sub_county);
  if (!sid || !String(b.name || '').trim() || !/^254\d{9}$/.test(b.whatsapp || '')) return fail(res, 400, 'Need a name, area and WhatsApp number like 2547XXXXXXXX');
  const r = await db.query('INSERT INTO traders(name,sub_county_id,market_id,goods,whatsapp,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
    [b.name.trim().slice(0, 100), sid, Number(b.market_id) || null, String(b.goods || '').slice(0, 120) || null, b.whatsapp, req.user.id]);
  log(req.user, 'trader_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/traders/:id/delete', crew, async (req, res) => {
  const t = (await db.query('SELECT sub_county_id FROM traders WHERE id=$1', [req.params.id])).rows[0];
  if (!t || !areaOk(req.user, t.sub_county_id)) return fail(res, 404, 'Trader not found');
  await db.query('UPDATE traders SET active=FALSE WHERE id=$1', [req.params.id]); log(req.user, 'trader_removed', req.params.id); res.json({ ok: true });
});

// G6: leagues, fixtures, scores and tables (table is worked out from played matches: 3 points a win, 1 a draw)
app.get('/api/sport', async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  const leagues = (await db.query('SELECT id, name, sport FROM leagues WHERE active AND ($1::int IS NULL OR sub_county_id=$1 OR sub_county_id IS NULL) ORDER BY name', [sid])).rows;
  const lid = Number(req.query.league) || leagues[0]?.id;
  if (!lid || !leagues.some(l => l.id === lid)) return res.json({ leagues, fixtures: [], pending: [], results: [], table: [] });
  const q = sql => db.query(sql, [lid]).then(r => r.rows);
  const [fixtures, pending, results, table] = await Promise.all([
    q(`SELECT id, home, away, kickoff, venue FROM matches WHERE league_id=$1 AND status='scheduled' AND kickoff >= NOW() - INTERVAL '3 hours' ORDER BY kickoff LIMIT 10`),
    q(`SELECT id, home, away, kickoff FROM matches WHERE league_id=$1 AND status='scheduled' AND kickoff < NOW() - INTERVAL '3 hours' ORDER BY kickoff DESC LIMIT 20`),
    q(`SELECT home, away, home_goals, away_goals, kickoff FROM matches WHERE league_id=$1 AND status='played' ORDER BY kickoff DESC LIMIT 10`),
    q(`WITH g AS (SELECT home AS team, home_goals AS gf, away_goals AS ga FROM matches WHERE league_id=$1 AND status='played'
         UNION ALL SELECT away, away_goals, home_goals FROM matches WHERE league_id=$1 AND status='played')
       SELECT team, COUNT(*)::int AS p, SUM((gf>ga)::int)::int AS w, SUM((gf=ga)::int)::int AS d, SUM((gf<ga)::int)::int AS l,
         (SUM(gf)-SUM(ga))::int AS gd, SUM(CASE WHEN gf>ga THEN 3 WHEN gf=ga THEN 1 ELSE 0 END)::int AS pts, SUM(gf)::int AS gf
       FROM g GROUP BY team ORDER BY pts DESC, gd DESC, gf DESC, team`)]);
  res.json({ league: lid, leagues, fixtures, pending, results, table });
});
const leagueFor = async (req, res, id) => {
  const l = (await db.query('SELECT id, sub_county_id FROM leagues WHERE id=$1 AND active', [id])).rows[0], u = req.user;
  if (!l || (l.sub_county_id === null ? u.role === 'hub_lead' : !areOk(u, l.sub_county_id))) { fail(res, 404, 'League not found'); return null; }
  return l;
};
app.post('/api/desk/leagues', crew, async (req, res) => {
  const b = req.body || {}, sid = b.sub_county === 'all' && staffOnly(req.user) ? null : await scopeSid(req, b.sub_county);
  if (!String(b.name || '').trim() || (sid === undefined)) return fail(res, 400, 'Need a league name and area');
  const r = await db.query('INSERT INTO leagues(name,sport,sub_county_id) VALUES($1,$2,$3) RETURNING id', [b.name.trim().slice(0, 80), String(b.sport || 'football').slice(0, 30), sid]);
  log(req.user, 'league_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/matches', crew, async (req, res) => {
  const b = req.body || {}, l = await leagueFor(req, res, b.league_id); if (!l) return;
  const k = new Date(b.kickoff);
  if (!String(b.home || '').trim() || !String(b.away || '').trim() || isNaN(k)) return fail(res, 400, 'Need both teams and a kickoff time');
  const r = await db.query('INSERT INTO matches(league_id,home,away,kickoff,venue) VALUES($1,$2,$3,$4,$5) RETURNING id', [l.id, b.home.trim().slice(0, 60), b.away.trim().slice(0, 60), k, String(b.venue || '').slice(0, 80) || null]);
  log(req.user, 'match_added', String(r.rows[0].id)); res.status(201).json({ id: r.rows[0].id });
});
const matchFor = async (req, res) => {
  const m = (await db.query('SELECT id, league_id FROM matches WHERE id=$1', [req.params.id])).rows[0];
  if (!m || !(await leagueFor(req, res, m.league_id))) { if (!res.headersSent) fail(res, 404, 'Match not found'); return null; }
  return m;
};
app.post('/api/desk/matches/:id/score', crew, async (req, res) => {
  const m = await matchFor(req, res); if (!m) return;
  const hg = parseInt(req.body?.hg, 10), ag = parseInt(req.body?.ag, 10);
  if (!(hg >= 0 && hg < 100 && ag >= 0 && ag < 100)) return fail(res, 400, 'Enter both scores');
  await db.query(`UPDATE matches SET home_goals=$2, away_goals=$3, status='played' WHERE id=$1`, [m.id, hg, ag]); log(req.user, 'score_entered', String(m.id), `${hg}-${ag}`); res.json({ ok: true });
});
app.post('/api/desk/matches/:id/delete', crew, async (req, res) => {
  const m = await matchFor(req, res); if (!m) return;
  await db.query('DELETE FROM matches WHERE id=$1', [m.id]); log(req.user, 'match_removed', String(m.id)); res.json({ ok: true });
});

// WhatsApp keyword helpers (G3 jobs, tenders, events, facts; sport; market days)
async function waList(kinds, sid, lang) {
  const r = await db.query(`SELECT title, body, event_date FROM notices WHERE kind = ANY($1) AND (sub_county_id=$2 OR sub_county_id IS NULL) AND (expires_on IS NULL OR expires_on >= CURRENT_DATE) ORDER BY created_at DESC LIMIT 5`, [kinds, sid]);
  return r.rows.length ? r.rows.map((n, i) => `${i + 1}. ${n.title}${n.event_date ? ' (' + String(n.event_date).slice(0, 10) + ')' : ''}\n${n.body.slice(0, 200)}`).join('\n\n') : TX[lang].none;
}
async function waMarket(sid, lang) {
  const r = await db.query('SELECT name, days FROM markets WHERE active AND sub_county_id=$1 ORDER BY name', [sid]);
  return r.rows.length ? r.rows.map(m => `${m.name}: ${m.days.join(', ')}`).join('\n') : TX[lang].none;
}
async function waSport(sid, lang) {
  const when = x => new Date(x).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' });
  const done = (await db.query(`SELECT m.home, m.away, m.home_goals, m.away_goals FROM matches m JOIN leagues l ON l.id=m.league_id WHERE m.status='played' AND (l.sub_county_id=$1 OR l.sub_county_id IS NULL) ORDER BY m.kickoff DESC LIMIT 5`, [sid])).rows;
  const next = (await db.query(`SELECT m.home, m.away, m.kickoff FROM matches m JOIN leagues l ON l.id=m.league_id WHERE m.status='scheduled' AND m.kickoff >= NOW() - INTERVAL '3 hours' AND (l.sub_county_id=$1 OR l.sub_county_id IS NULL) ORDER BY m.kickoff LIMIT 3`, [sid])).rows;
  const out = [];
  if (done.length) out.push('Results\n' + done.map(m => `${m.home} ${m.home_goals}-${m.away_goals} ${m.away}`).join('\n'));
  if (next.length) out.push('Next\n' + next.map(m => `${m.home} v ${m.away}, ${when(m.kickoff)}`).join('\n'));
  return out.join('\n\n') || TX[lang].none;
}

// ---- Phase 4: M-Pesa charges, verified badge, ticketing, rates and reports, insight subscriptions
const BADGE_PRICE = Number(E.BADGE_PRICE_KES || 2000), BADGE_DAYS = Number(E.BADGE_DAYS || 365);
async function stk(phone, amount, ref, desc) {
  const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const token = await mpesaToken();
  const r = await axios.post(`${E.MPESA_BASE}/mpesa/stkpush/v1/processrequest`, {
    BusinessShortCode: E.MPESA_SHORTCODE, Password: Buffer.from(E.MPESA_SHORTCODE + E.MPESA_PASSKEY + ts).toString('base64'), Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline', Amount: amount, PartyA: phone, PartyB: E.MPESA_SHORTCODE, PhoneNumber: phone,
    CallBackURL: `${E.PUBLIC_URL}/api/mpesa-callback/${E.MPESA_CALLBACK_SECRET}`, AccountReference: String(ref).slice(0, 12), TransactionDesc: String(desc).slice(0, 20)
  }, { headers: { Authorization: `Bearer ${token}` } });
  return r.data.CheckoutRequestID;
}
async function makeCharge(kind, refId, phone, amount, ref, desc) {
  const pid = crypto.randomBytes(12).toString('hex'), cid = await stk(phone, amount, ref, desc);
  const r = await db.query('INSERT INTO charges(public_id,kind,ref_id,phone,amount,checkout_request_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [pid, kind, refId, phone, amount, cid]);
  return { id: r.rows[0].id, pid };
}
async function settleCharge(ch, meta) {
  if (Number(meta.Amount) < ch.amount) { await db.query(`UPDATE charges SET status='underpaid' WHERE id=$1`, [ch.id]); return; }
  const up = await db.query(`UPDATE charges SET status='paid', receipt=$2 WHERE id=$1 AND status='pending' RETURNING id`, [ch.id, meta.MpesaReceiptNumber]);
  if (!up.rowCount) return;                                                  // already settled
  if (ch.kind === 'badge') await db.query(`UPDATE merchants SET badge_paid_until = GREATEST(COALESCE(badge_paid_until, NOW()), NOW()) + ($2 || ' days')::interval WHERE id=$1`, [ch.ref_id, BADGE_DAYS]);
  if (ch.kind === 'ticket') await db.query(`UPDATE tickets SET status='paid' WHERE charge_id=$1 AND status='pending'`, [ch.id]);
  if (ch.kind === 'board') await db.query(`UPDATE board_posts SET paid=TRUE, status='pending' WHERE id=$1 AND status='awaiting_payment'`, [ch.ref_id]);
}

// I1: verified badge. Pay, then our team checks the business; the badge shows once both are done.
app.post('/api/verify/request', strict, async (req, res) => {
  const { whatsapp, phone } = req.body || {};
  if (!/^254\d{9}$/.test(whatsapp || '') || !/^254[17]\d{8}$/.test(phone || '')) return fail(res, 400, 'Phone numbers must look like 2547XXXXXXXX');
  const m = (await db.query(`SELECT id, business_name FROM merchants WHERE whatsapp=$1 AND status='ACTIVE' AND expires_at > NOW() ORDER BY id DESC LIMIT 1`, [whatsapp])).rows[0];
  if (!m) return fail(res, 404, 'No active listing with that WhatsApp number. List your business first.');
  try { await makeCharge('badge', m.id, phone, BADGE_PRICE, m.business_name, 'Verified badge'); res.json({ message: `Check your phone for the KSh ${BADGE_PRICE} M-Pesa prompt. After payment our team will verify your business and the badge will appear.` }); }
  catch (e) { console.error(e.response?.data || e.message); fail(res, 502, 'Could not start payment. Try again.'); }
});
app.post('/api/desk/merchants/:id/verify', admin, async (req, res) => {
  const on = !!req.body?.verified;
  const r = await db.query(`UPDATE merchants SET verified_at=$2, verified_by=$3 WHERE id=$1 RETURNING id`, [req.params.id, on ? new Date() : null, on ? req.user.id : null]);
  if (!r.rowCount) return fail(res, 404, 'Listing not found'); log(req.user, on ? 'merchant_verified' : 'merchant_unverified', req.params.id); res.json({ ok: true });
});

// I3: event ticketing. Buyers pay by M-Pesa; the paper holds the money and settles with the organiser (commission set per event)
const SOLD = `(SELECT COUNT(*)::int FROM tickets t WHERE t.event_id=e.id AND (t.status IN ('paid','used') OR (t.status='pending' AND t.created_at > NOW() - INTERVAL '10 minutes')))`;
const newCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = crypto.randomBytes(8); return Array.from(b, x => A[x % A.length]).join(''); };
app.get('/api/tix/events', async (req, res) => res.json((await db.query(
  `SELECT e.id, e.title, e.description, e.venue, e.starts_at, e.price_kes, e.organiser, sc.name AS area, e.capacity - ${SOLD} AS left
   FROM ticketed_events e LEFT JOIN sub_counties sc ON sc.id=e.sub_county_id WHERE e.active AND e.starts_at > NOW() - INTERVAL '3 hours' ORDER BY e.starts_at LIMIT 30`)).rows));
app.post('/api/tix/buy', strict, async (req, res) => {
  const b = req.body || {}, qty = parseInt(b.qty, 10);
  if (!/^254[17]\d{8}$/.test(b.phone || '') || !(qty >= 1 && qty <= 5)) return fail(res, 400, 'Choose 1 to 5 tickets and enter your M-Pesa number like 2547XXXXXXXX');
  const e = (await db.query(`SELECT e.id, e.title, e.price_kes, e.capacity - ${SOLD} AS left FROM ticketed_events e WHERE e.id=$1 AND e.active AND e.starts_at > NOW()`, [b.event_id])).rows[0];
  if (!e) return fail(res, 404, 'Event not available');
  if (e.left < qty) return fail(res, 409, e.left > 0 ? `Only ${e.left} ticket${e.left > 1 ? 's' : ''} left` : 'Sold out');
  const codes = Array.from({ length: qty }, newCode), name = String(b.name || '').trim().slice(0, 80) || null;
  for (const c of codes) await db.query('INSERT INTO tickets(event_id,code,buyer_name,buyer_phone,status) VALUES($1,$2,$3,$4,$5)', [e.id, c, name, b.phone, e.price_kes === 0 ? 'paid' : 'pending']);
  if (e.price_kes === 0) return res.json({ pid: null, codes });
  try {
    const c = await makeCharge('ticket', e.id, b.phone, e.price_kes * qty, e.title, 'Event ticket');
    await db.query('UPDATE tickets SET charge_id=$1 WHERE code = ANY($2)', [c.id, codes]);
    res.json({ pid: c.pid, message: 'Check your phone and enter your M-Pesa PIN.' });
  } catch (err) { console.error(err.response?.data || err.message); await db.query(`UPDATE tickets SET status='cancelled' WHERE code = ANY($1)`, [codes]); fail(res, 502, 'Could not start payment. Try again.'); }
});
app.get('/api/tix/status/:pid', async (req, res) => {
  const ch = (await db.query(`SELECT id, status FROM charges WHERE public_id=$1 AND kind='ticket'`, [req.params.pid])).rows[0];
  if (!ch) return fail(res, 404, 'Not found');
  const t = ch.status === 'paid' ? (await db.query(`SELECT t.code, e.title AS event, e.starts_at, e.venue FROM tickets t JOIN ticketed_events e ON e.id=t.event_id WHERE t.charge_id=$1 AND t.status IN ('paid','used')`, [ch.id])).rows : [];
  res.json({ status: ch.status, tickets: t });
});
app.post('/api/desk/tix/events', admin, async (req, res) => {
  const b = req.body || {}, sid = b.sub_county ? await subId(b.sub_county) : null, k = new Date(b.starts_at);
  const price = parseInt(b.price_kes, 10), cap = parseInt(b.capacity, 10), pct = b.commission_pct === '' || b.commission_pct == null ? 10 : parseInt(b.commission_pct, 10);
  if (!String(b.title || '').trim() || !String(b.organiser || '').trim() || isNaN(k) || !(price >= 0) || !(cap > 0) || !(pct >= 0 && pct <= 100)) return fail(res, 400, 'Need title, organiser, date, price, capacity and a commission between 0 and 100');
  const r = await db.query(`INSERT INTO ticketed_events(title,description,venue,starts_at,sub_county_id,price_kes,capacity,organiser,organiser_phone,commission_pct,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [b.title.trim().slice(0, 120), String(b.description || '').slice(0, 500) || null, String(b.venue || '').slice(0, 120) || null, k, sid, price, cap, b.organiser.trim().slice(0, 100), /^254\d{9}$/.test(b.organiser_phone || '') ? b.organiser_phone : null, pct, req.user.id]);
  log(req.user, 'event_created', String(r.rows[0].id), b.title); res.status(201).json({ id: r.rows[0].id });
});
app.get('/api/desk/tix/events', admin, async (req, res) => res.json((await db.query(
  `SELECT e.id, e.title, e.starts_at, e.price_kes, e.capacity, e.organiser, e.organiser_phone, e.commission_pct, e.active, e.paid_out_at,
     (SELECT COUNT(*)::int FROM tickets t WHERE t.event_id=e.id AND t.status IN ('paid','used')) AS sold,
     (SELECT COUNT(*)::int FROM tickets t WHERE t.event_id=e.id AND t.status='used') AS checked_in
   FROM ticketed_events e ORDER BY e.starts_at DESC LIMIT 30`)).rows));
app.post('/api/desk/tix/events/:id/close', admin, async (req, res) => {
  const r = await db.query('UPDATE ticketed_events SET active=FALSE WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Event not found'); log(req.user, 'event_closed', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/tix/events/:id/payout', admin, async (req, res) => {
  const r = await db.query('UPDATE ticketed_events SET paid_out_at=NOW() WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Event not found'); log(req.user, 'organiser_paid_out', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/tix/checkin', auth, async (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const r = await db.query(`UPDATE tickets SET status='used', used_at=NOW() WHERE code=$1 AND status='paid' RETURNING buyer_name, event_id`, [code]);
  if (r.rowCount) { const e = (await db.query('SELECT title FROM ticketed_events WHERE id=$1', [r.rows[0].event_id])).rows[0]; return res.json({ ok: true, message: `VALID: ${e.title}, ${r.rows[0].buyer_name || 'no name'}` }); }
  const t = (await db.query('SELECT status, used_at FROM tickets WHERE code=$1', [code])).rows[0];
  res.json({ ok: false, message: !t ? 'UNKNOWN CODE' : t.status === 'used' ? `ALREADY USED at ${new Date(t.used_at).toLocaleTimeString('en-GB', { timeZone: 'Africa/Nairobi' })}` : t.status === 'pending' ? 'NOT PAID YET' : 'CANCELLED' });
});
app.post('/api/desk/tix/:code/mark-paid', admin, async (req, res) => {       // if a payment went through but the confirmation never arrived
  const code = String(req.params.code).toUpperCase(), receipt = String(req.body?.receipt || '').trim().toUpperCase().slice(0, 30);
  const t = (await db.query('SELECT charge_id FROM tickets WHERE code=$1', [code])).rows[0];
  if (!t || !t.charge_id || receipt.length < 8) return fail(res, 400, 'Need a ticket code and the M-Pesa receipt number');
  await db.query(`UPDATE charges SET status='paid', receipt=$2 WHERE id=$1 AND status<>'paid'`, [t.charge_id, receipt]);
  await db.query(`UPDATE tickets SET status='paid' WHERE charge_id=$1 AND status='pending'`, [t.charge_id]); log(req.user, 'ticket_marked_paid', code, receipt); res.json({ ok: true });
});

// I4: rates, live audience numbers, per-business report
app.get('/api/rates', async (req, res) => {
  const custom = (await db.query('SELECT id, name, price_kes, unit, details FROM rates WHERE active ORDER BY price_kes')).rows;
  res.json({ contact: E.PUBLIC_CONTACT || '', rates: [
    { name: 'Business listing', price_kes: PRICE, unit: `${DAYS} days`, details: 'Appears in your sub-county with a tap-to-chat WhatsApp button and a place on the map.' },
    { name: 'Verified badge', price_kes: BADGE_PRICE, unit: `${BADGE_DAYS} days`, details: 'We check your business, then a Verified badge shows on your listing.' }, ...custom] });
});
app.post('/api/desk/rates', admin, async (req, res) => {
  const b = req.body || {}, p = parseInt(b.price_kes, 10);
  if (!String(b.name || '').trim() || !(p >= 0) || !String(b.unit || '').trim()) return fail(res, 400, 'Need a name, a price and a unit (for example per month)');
  const r = await db.query('INSERT INTO rates(name,price_kes,unit,details) VALUES($1,$2,$3,$4) RETURNING id', [b.name.trim().slice(0, 80), p, b.unit.trim().slice(0, 30), String(b.details || '').slice(0, 300) || null]);
  log(req.user, 'rate_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/rates/:id/delete', admin, async (req, res) => {
  const r = await db.query('UPDATE rates SET active=FALSE WHERE id=$1 RETURNING id', [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Rate not found'); log(req.user, 'rate_removed', req.params.id); res.json({ ok: true });
});
let statsCache = { at: 0, data: null };
app.get('/api/stats', async (req, res) => {                                    // our own counts: views are page loads, not unique people
  if (Date.now() - statsCache.at > 600000) {
    const [ev, area, wa, biz, st] = await Promise.all([
      db.query(`SELECT kind, COUNT(*)::int AS n FROM events WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY kind`),
      db.query(`SELECT sc.name, COUNT(*)::int AS n FROM events e JOIN sub_counties sc ON sc.id=e.sub_county_id WHERE e.kind='page_view' AND e.created_at > NOW() - INTERVAL '30 days' GROUP BY sc.name ORDER BY n DESC`),
      db.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE subscribed)::int AS subscribed FROM wa_users'),
      db.query(`SELECT COUNT(*)::int AS n FROM merchants WHERE status='ACTIVE' AND expires_at > NOW()`),
      db.query(`SELECT COUNT(*)::int AS n FROM stories WHERE status='approved' AND approved_at > NOW() - INTERVAL '30 days'`)]);
    statsCache = { at: Date.now(), data: { days: 30, events: Object.fromEntries(ev.rows.map(r => [r.kind, r.n])), views_by_area: area.rows, whatsapp: wa.rows[0], active_listings: biz.rows[0].n, stories: st.rows[0].n } };
  }
  res.set('Cache-Control', 'public, max-age=300').json(statsCache.data);
});
app.get('/api/report/:token', async (req, res) => {
  const m = (await db.query('SELECT id, business_name, status, expires_at, sub_county_id FROM merchants WHERE report_token=$1', [req.params.token])).rows[0];
  if (!m) return fail(res, 404, 'Report not found');
  const [taps, views] = await Promise.all([
    db.query(`SELECT created_at::date AS day, COUNT(*)::int AS n FROM events WHERE kind='merchant_tap' AND ref=$1 AND created_at > NOW() - INTERVAL '30 days' GROUP BY 1 ORDER BY 1`, [String(m.id)]),
    db.query(`SELECT COUNT(*)::int AS n FROM events WHERE kind='page_view' AND sub_county_id=$1 AND created_at > NOW() - INTERVAL '30 days'`, [m.sub_county_id])]);
  res.json({ business: m.business_name, status: m.status, expires_at: m.expires_at, taps_total: taps.rows.reduce((a, r) => a + r.n, 0), taps_by_day: taps.rows, area_views: views.rows[0].n });
});

// I5: insight subscriptions for NGOs, planners and agribusiness. Aggregated and anonymous only; small counts are hidden.
const insightKey = async (req, res, next) => {
  const k = req.get('x-api-key') || '';
  const c = k && (await db.query('SELECT id, org FROM insight_clients WHERE key_hash=$1 AND active_until >= CURRENT_DATE', [hash(k)])).rows[0];
  if (!c) return fail(res, 401, 'Key not valid or subscription ended'); req.client = c; next();
};
app.get('/api/insights/data', insightKey, async (req, res) => {
  const [prices, attention, topics, rumours] = await Promise.all([
    db.query(`SELECT date_trunc('week', ph.recorded_at)::date AS week, sc.name AS area, ph.commodity, ROUND(AVG(ph.local_price),0)::int AS local, ROUND(AVG(ph.benchmark_price),0)::int AS mombasa, COUNT(*)::int AS readings
      FROM price_history ph JOIN sub_counties sc ON sc.id=ph.sub_county_id WHERE ph.recorded_at > NOW() - INTERVAL '12 weeks' GROUP BY 1,2,3 ORDER BY 1 DESC, 2, 3`),
    db.query(`SELECT date_trunc('week', e.created_at)::date AS week, sc.name AS area, COUNT(*)::int AS views FROM events e JOIN sub_counties sc ON sc.id=e.sub_county_id
      WHERE e.kind='page_view' AND e.created_at > NOW() - INTERVAL '12 weeks' GROUP BY 1,2 HAVING COUNT(*) >= 10 ORDER BY 1 DESC, 2`),
    db.query(`SELECT date_trunc('week', s.approved_at)::date AS week, sc.name AS area, s.topic, COUNT(*)::int AS stories FROM stories s JOIN sub_counties sc ON sc.id=s.sub_county_id
      WHERE s.status='approved' AND s.approved_at > NOW() - INTERVAL '12 weeks' GROUP BY 1,2,3 ORDER BY 1 DESC, 2, 3`),
    db.query(`SELECT split_part(body, '.', 1) AS verdict, COUNT(*)::int AS claims FROM notices WHERE kind='factcheck' AND created_at > NOW() - INTERVAL '12 weeks' GROUP BY 1 ORDER BY 2 DESC`)]);
  res.json({ org: req.client.org, note: 'Aggregated and anonymous. Counts under 10 are hidden. Views are page loads, not unique people. Prices are market readings entered by our team.',
    prices: prices.rows, attention: attention.rows, topics: topics.rows, fact_checks: rumours.rows });
});
app.get('/api/desk/insight-clients', admin, async (req, res) => res.json((await db.query('SELECT id, org, contact, active_until FROM insight_clients ORDER BY active_until DESC LIMIT 50')).rows));
app.post('/api/desk/insight-clients', admin, async (req, res) => {
  const b = req.body || {}, months = parseInt(b.months, 10);
  if (!String(b.org || '').trim() || !(months >= 1 && months <= 36)) return fail(res, 400, 'Need an organisation and 1 to 36 months');
  const key = 'ins_' + crypto.randomBytes(20).toString('hex');
  const r = await db.query(`INSERT INTO insight_clients(org,contact,key_hash,active_until,created_by) VALUES($1,$2,$3,CURRENT_DATE + ($4 || ' months')::interval,$5) RETURNING id`,
    [b.org.trim().slice(0, 120), String(b.contact || '').slice(0, 120) || null, hash(key), months, req.user.id]);
  log(req.user, 'insight_client_added', String(r.rows[0].id), b.org); res.status(201).json({ id: r.rows[0].id, key });
});
app.post('/api/desk/insight-clients/:id/extend', admin, async (req, res) => {
  const months = parseInt(req.body?.months, 10);
  if (!(months >= 1 && months <= 36)) return fail(res, 400, 'Choose 1 to 36 months');
  const r = await db.query(`UPDATE insight_clients SET active_until = GREATEST(active_until, CURRENT_DATE) + ($2 || ' months')::interval WHERE id=$1 RETURNING id`, [req.params.id, months]);
  if (!r.rowCount) return fail(res, 404, 'Client not found'); log(req.user, 'insight_client_extended', req.params.id); res.json({ ok: true });
});
app.post('/api/desk/insight-clients/:id/end', admin, async (req, res) => {
  const r = await db.query(`UPDATE insight_clients SET active_until = CURRENT_DATE - 1 WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rowCount) return fail(res, 404, 'Client not found'); log(req.user, 'insight_client_ended', req.params.id); res.json({ ok: true });
});

// ---- Phase 5: print supplement
app.get('/api/story/:id', async (req, res) => {                                  // full text, loaded only when a reader asks for it
  const r = await db.query(`SELECT body FROM stories WHERE id=$1 AND status='approved'`, [req.params.id]);
  r.rowCount ? res.set('Cache-Control', 'public, max-age=300').json({ body: r.rows[0].body || '' }) : fail(res, 404, 'Story not found');
});
app.get('/api/desk/print/stories', admin, async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null, days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 90);
  res.json((await db.query(`SELECT s.id, s.headline, s.topic, s.placement, s.paper, s.pair_id, (s.body IS NOT NULL) AS has_body, s.approved_at, sc.name AS area
    FROM stories s JOIN sub_counties sc ON sc.id=s.sub_county_id
    WHERE s.status='approved' AND ($1::int IS NULL OR s.sub_county_id=$1) AND s.approved_at > NOW() - make_interval(days => $2)
    ORDER BY (s.placement='issue') DESC, s.approved_at DESC LIMIT 80`, [sid, days])).rows);
});
app.get('/api/print/data', async (req, res) => {                                  // everything the print layout needs; all of it is already public
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean).slice(0, 40);
  if (!ids.length) return fail(res, 400, 'No stories chosen');
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  const stories = (await db.query(`SELECT s.id, s.headline, s.bullets, s.body, s.topic, s.paper, s.image_url, s.place_name, s.approved_at, s.pair_id, sc.name AS area, c.name AS reporter,
      (SELECT json_agg(json_build_object('note', x.note, 'at', x.created_at) ORDER BY x.created_at DESC) FROM corrections x WHERE x.story_id=s.id) AS corrections
    FROM stories s JOIN sub_counties sc ON sc.id=s.sub_county_id LEFT JOIN users c ON c.id=s.author_id WHERE s.status='approved' AND s.id = ANY($1)`, [ids])).rows;
  const order = new Map(ids.map((id, i) => [id, i])); stories.sort((a, b) => order.get(a.id) - order.get(b.id));
  const lg = (await db.query(`SELECT id, name FROM leagues WHERE active AND ($1::int IS NULL OR sub_county_id=$1 OR sub_county_id IS NULL) ORDER BY id LIMIT 1`, [sid])).rows[0];
  const [prices, notices, markets, merchants, results, fixtures, table] = await Promise.all([
    db.query(`SELECT sc.name AS area, p.commodity, p.local_price, p.benchmark_price FROM market_prices p JOIN sub_counties sc ON sc.id=p.sub_county_id
      WHERE ($1::int IS NULL OR p.sub_county_id=$1) AND p.updated_at > NOW() - make_interval(days => 7) ORDER BY p.commodity, sc.name`, [sid]),
    db.query(`SELECT kind, title, body, event_date FROM notices WHERE kind IN ('job','tender','event','notice','obituary') AND (expires_on IS NULL OR expires_on >= CURRENT_DATE)
      AND ($1::int IS NULL OR sub_county_id=$1 OR sub_county_id IS NULL) ORDER BY kind, created_at DESC LIMIT 24`, [sid]),
    db.query(`SELECT m.name, m.days, sc.name AS area FROM markets m JOIN sub_counties sc ON sc.id=m.sub_county_id WHERE m.active AND ($1::int IS NULL OR m.sub_county_id=$1) ORDER BY sc.name, m.name`, [sid]),
    db.query(`SELECT m.business_name, m.tagline, m.whatsapp, m.category, (m.verified_at IS NOT NULL AND m.badge_paid_until > NOW()) AS verified, sc.name AS area
      FROM merchants m JOIN sub_counties sc ON sc.id=m.sub_county_id WHERE m.status='ACTIVE' AND m.expires_at > NOW() AND ($1::int IS NULL OR m.sub_county_id=$1)
      ORDER BY (m.verified_at IS NOT NULL AND m.badge_paid_until > NOW()) DESC, m.category, m.business_name LIMIT 80`, [sid]),
    db.query(`SELECT l.name AS league, m.home, m.away, m.home_goals, m.away_goals FROM matches m JOIN leagues l ON l.id=m.league_id
      WHERE m.status='played' AND ($1::int IS NULL OR l.sub_county_id=$1 OR l.sub_county_id IS NULL) ORDER BY m.kickoff DESC LIMIT 8`, [sid]),
    db.query(`SELECT m.home, m.away, m.kickoff, m.venue FROM matches m JOIN leagues l ON l.id=m.league_id
      WHERE m.status='scheduled' AND m.kickoff >= NOW() AND ($1::int IS NULL OR l.sub_county_id=$1 OR l.sub_county_id IS NULL) ORDER BY m.kickoff LIMIT 8`, [sid]),
    lg ? db.query(`WITH g AS (SELECT home AS team, home_goals AS gf, away_goals AS ga FROM matches WHERE league_id=$1 AND status='played'
        UNION ALL SELECT away, away_goals, home_goals FROM matches WHERE league_id=$1 AND status='played')
      SELECT team, COUNT(*)::int AS p, (SUM(gf)-SUM(ga))::int AS gd, SUM(CASE WHEN gf>ga THEN 3 WHEN gf=ga THEN 1 ELSE 0 END)::int AS pts
      FROM g GROUP BY team ORDER BY pts DESC, gd DESC, SUM(gf) DESC, team LIMIT 10`, [lg.id]) : { rows: [] }]);
  const boards = (await db.query(`SELECT board, title, summary, event_date, venue, extra, confirmed_at IS NOT NULL AS confirmed FROM board_posts WHERE status='published' AND expires_on >= CURRENT_DATE
    AND ($1::int IS NULL OR sub_county_id=$1 OR sub_county_id IS NULL) ORDER BY board, published_at DESC LIMIT 40`, [sid])).rows;
  boards.forEach(b => { if (!b.confirmed) { delete b.extra.paybill; delete b.extra.paybill_name; } });
  res.json({ url: E.PUBLIC_URL || '', contact: E.PUBLIC_CONTACT || '', boards, stories, prices: prices.rows, notices: notices.rows, markets: markets.rows, merchants: merchants.rows,
    sport: { league: lg?.name || null, results: results.rows, fixtures: fixtures.rows, table: table.rows } });
});

// ---- Lead story: its photo fronts the main page
app.get('/api/lead', async (req, res) => {
  const paper = ['review', 'roundup'].includes(req.query.paper) ? req.query.paper : null;
  const r = await db.query(`SELECT s.id, s.headline, s.bullets, s.topic, s.paper, s.image_url, s.video_url, s.created_at, (s.body IS NOT NULL) AS has_body, sc.name AS area,
      (s.breaking AND s.approved_at > NOW() - INTERVAL '24 hours') AS breaking, c.name AS reporter,
      (SELECT json_agg(json_build_object('note', x.note, 'at', x.created_at) ORDER BY x.created_at DESC) FROM corrections x WHERE x.story_id=s.id) AS corrections
    FROM stories s JOIN sub_counties sc ON sc.id=s.sub_county_id LEFT JOIN users c ON c.id=s.author_id
    WHERE s.status='approved' AND s.image_url IS NOT NULL AND ($1::text IS NULL OR s.paper IN ($1, 'both'))
      AND (s.lead_at > NOW() - INTERVAL '48 hours' OR s.approved_at > NOW() - INTERVAL '7 days')
    ORDER BY CASE WHEN s.lead_at > NOW() - INTERVAL '48 hours' THEN 1 ELSE 0 END DESC, s.lead_at DESC NULLS LAST, s.approved_at DESC LIMIT 1`, [paper]);
  res.set('Cache-Control', 'public, max-age=60').json(r.rows[0] || {});
});
app.post('/api/desk/stories/:id/lead', admin, async (req, res) => {
  const r = await db.query(`UPDATE stories SET lead_at=NOW() WHERE id=$1 AND status='approved' AND image_url IS NOT NULL RETURNING id`, [req.params.id]);
  if (!r.rowCount) return fail(res, 400, 'Only a published story with a photo can lead');
  log(req.user, 'lead_story_set', req.params.id); res.json({ ok: true });
});

// ---- Phase 6: fares, facilities, roads, price history, notice boards
// K1 transport fares
app.get('/api/fares', async (req, res) => {
  const q = req.query.q ? `%${String(req.query.q).replace(/[%_]/g, '')}%` : null;
  res.json((await db.query(`SELECT id, from_place, to_place, mode, fare_kes, operator, whatsapp, pinned, updated_at FROM fares
    WHERE active AND updated_at > NOW() - make_interval(days => 14) AND ($1::text IS NULL OR from_place ILIKE $1 OR to_place ILIKE $1 OR operator ILIKE $1)
    ORDER BY pinned DESC, from_place, to_place, fare_kes LIMIT 80`, [q])).rows);
});
app.post('/api/desk/fares', crew, async (req, res) => {
  const b = req.body || {}, fare = parseInt(b.fare_kes, 10);
  if (!String(b.from_place || '').trim() || !String(b.to_place || '').trim() || !(fare > 0 && fare < 100000) || !['matatu', 'bus', 'sgr', 'boda', 'taxi'].includes(b.mode)) return fail(res, 400, 'Need from, to, mode and a fare');
  if (b.whatsapp && !/^254\d{9}$/.test(b.whatsapp)) return fail(res, 400, 'WhatsApp number must look like 2547XXXXXXXX');
  const op = String(b.operator || '').trim().slice(0, 80) || null;
  await db.query(`DELETE FROM fares WHERE lower(from_place)=lower($1) AND lower(to_place)=lower($2) AND mode=$3 AND COALESCE(operator,'')=COALESCE($4,'')`, [b.from_place.trim(), b.to_place.trim(), b.mode, op]);
  const r = await db.query('INSERT INTO fares(from_place,to_place,mode,fare_kes,operator,whatsapp,pinned) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [b.from_place.trim().slice(0, 60), b.to_place.trim().slice(0, 60), b.mode, fare, op, b.whatsapp || null, staffOnly(req.user) && !!b.pinned]);
  log(req.user, 'fare_set', String(r.rows[0].id), `${b.from_place}-${b.to_place}`); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/fares/:id/delete', crew, async (req, res) => {
  const r = await db.query('UPDATE fares SET active=FALSE WHERE id=$1 RETURNING id', [req.params.id]);
  r.rowCount ? res.json({ ok: true }) : fail(res, 404, 'Fare not found');
});
// K2 clinics, hospitals, pharmacies
app.get('/api/facilities', async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  res.json((await db.query(`SELECT id, name, kind, phone, services, hours, open_24h, (featured_until >= CURRENT_DATE) AS featured FROM facilities
    WHERE active AND ($1::int IS NULL OR sub_county_id=$1) AND ($2::boolean IS NOT TRUE OR open_24h)
    ORDER BY open_24h DESC, (featured_until >= CURRENT_DATE) DESC NULLS LAST, name LIMIT 60`, [sid, req.query.open24 === '1'])).rows);
});
app.post('/api/desk/facilities', crew, async (req, res) => {
  const b = req.body || {}, sid = await scopeSid(req, b.sub_county);
  if (!sid || !String(b.name || '').trim() || !['hospital', 'clinic', 'pharmacy'].includes(b.kind)) return fail(res, 400, 'Need a name, a type and an area');
  if (b.phone && !/^254\d{9}$/.test(b.phone)) return fail(res, 400, 'Phone must look like 2547XXXXXXXX');
  const days = staffOnly(req.user) ? parseInt(b.featured_days, 10) : 0;
  const r = await db.query(`INSERT INTO facilities(name,kind,sub_county_id,phone,services,hours,open_24h,featured_until) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $8 > 0 THEN CURRENT_DATE + $8::int ELSE NULL END) RETURNING id`,
    [b.name.trim().slice(0, 100), b.kind, sid, b.phone || null, String(b.services || '').slice(0, 200) || null, String(b.hours || '').slice(0, 80) || null, !!b.open_24h, days > 0 ? days : 0]);
  log(req.user, 'facility_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
app.post('/api/desk/facilities/:id/delete', crew, async (req, res) => {
  const f = (await db.query('SELECT sub_county_id FROM facilities WHERE id=$1', [req.params.id])).rows[0];
  if (!f || !areaOk(req.user, f.sub_county_id)) return fail(res, 404, 'Not found');
  await db.query('UPDATE facilities SET active=FALSE WHERE id=$1', [req.params.id]); res.json({ ok: true });
});
// K3 road and fog status (hides itself after 24 hours so old news never misleads)
app.get('/api/roads', async (req, res) => res.json((await db.query(
  `SELECT road, status, note, updated_at FROM road_status WHERE updated_at > NOW() - INTERVAL '24 hours' ORDER BY CASE status WHEN 'heavy' THEN 0 WHEN 'patchy' THEN 1 ELSE 2 END, road`)).rows));
app.post('/api/desk/roads', crew, async (req, res) => {
  const b = req.body || {};
  if (!String(b.road || '').trim() || !['clear', 'patchy', 'heavy'].includes(b.status)) return fail(res, 400, 'Need a road and a status');
  await db.query(`INSERT INTO road_status(road,status,note,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT (road) DO UPDATE SET status=$2, note=$3, updated_at=NOW(), updated_by=$4`,
    [b.road.trim().slice(0, 80), b.status, String(b.note || '').slice(0, 200) || null, req.user.id]);
  log(req.user, 'road_status', b.road, b.status); res.json({ ok: true });
});
app.post('/api/desk/roads/delete', crew, async (req, res) => { await db.query('DELETE FROM road_status WHERE road=$1', [String(req.body?.road || '')]); res.json({ ok: true }); });
// K4 price history for the tap-to-expand trend
app.get('/api/prices/history', async (req, res) => {
  const sid = await subId(req.query.sub_county || ''), c = String(req.query.commodity || '').slice(0, 50);
  res.json(sid && c ? (await db.query(`SELECT date_trunc('week', recorded_at)::date AS week, ROUND(AVG(local_price),0)::int AS local FROM price_history
    WHERE sub_county_id=$1 AND commodity=$2 AND recorded_at > NOW() - INTERVAL '8 weeks' GROUP BY 1 ORDER BY 1`, [sid, c])).rows : []);
});

// K7, K8, K13: memorial, celebration and legal boards
const FEES = { memorial: Number(E.MEMORIAL_FEE_KES || 500), celebration_basic: Number(E.CELEBRATION_BASIC_KES || 0), celebration_featured: Number(E.CELEBRATION_FEATURED_KES || 500), legal: Number(E.LEGAL_FEE_KES || 3000), lostfound: 0, missing: 0, chama: 0 };
const feeFor = (board, tier) => board === 'celebration' ? (tier === 'featured' ? FEES.celebration_featured : FEES.celebration_basic) : FEES[board];
const RUNDAYS = { memorial: 90, legal: 14, basic: 3, featured: 7, lostfound: 30, missing: 60, chama: 180, coroner: 30 };
const boardLimit = rateLimit({ windowMs: 60000, max: 4 });
app.get('/api/boards/fees', (req, res) => res.json(FEES));
app.post('/api/boards/submit', boardLimit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true });                                   // bot trap
  const board = b.board;
  if (!['memorial', 'celebration', 'legal', 'lostfound', 'missing', 'chama'].includes(board)) return fail(res, 400, 'Unknown board');
  const title = maskIf(board, String(b.title || '').trim().slice(0, 150)), summary = maskIf(board, String(b.summary || '').trim()), ex = b.extra && typeof b.extra === 'object' ? b.extra : {};
  const phone = /^254\d{9}$/.test(b.contact_phone || '') ? b.contact_phone : null, pay = /^254[17]\d{8}$/.test(b.pay_phone || '') ? b.pay_phone : null;
  const tier = board === 'celebration' && b.tier === 'featured' ? 'featured' : 'basic', maxLen = board === 'legal' ? 2500 : board === 'missing' ? 600 : tier === 'featured' ? 800 : 300;
  if (title.length < 3 || summary.length < 20 || summary.length > maxLen) return fail(res, 400, `Give a title and a description of 20 to ${maxLen} characters`);
  if ((summary.match(/https?:\/\//gi) || []).length > 1) return fail(res, 400, 'Please remove the web links');
  const KEEP = { legal: ['case_no', 'court', 'order_date', 'advocate', 'firm', 'notice_kind'], memorial: ['years', 'paybill', 'paybill_name'], celebration: ['for_whom'], lostfound: ['kind', 'category'],
    missing: ['category', 'age', 'gender', 'last_seen_place', 'last_seen_date', 'police_ob', 'police_station', 'photo_consent'], chama: ['kind', 'members', 'meets', 'open'] }, keep = KEEP[board], clean = {};
  for (const k of keep) if (ex[k] != null && String(ex[k]).trim()) clean[k] = String(ex[k]).trim().slice(0, 120);
  if (board === 'legal' && (!phone || !clean.case_no || !clean.court || !clean.order_date || !clean.advocate)) return fail(res, 400, 'Legal notices need the case number, court, order date, advocate name and a phone number');
  if (board === 'memorial' && !phone) return fail(res, 400, 'Add a contact phone number for the family or committee');
  if (board === 'lostfound' && (!phone || !['lost', 'found'].includes(clean.kind))) return fail(res, 400, 'Say whether it is lost or found, and add a phone number');
  if (board === 'missing' && (!phone || !clean.police_ob || !clean.police_station)) return fail(res, 400, 'Missing person notices need the police OB number, the police station and a contact phone');
  if (board === 'missing') clean.case_status = 'missing';
  if (board === 'chama' && !phone) return fail(res, 400, 'Add the chairperson or secretary phone number');
  const fee = feeFor(board, tier);
  if (fee > 0 && !pay) return fail(res, 400, 'Enter the M-Pesa number to pay from (2547XXXXXXXX)');
  const who = whoHash((phone || pay || req.ip) + 'b');
  if ((await db.query(`SELECT COUNT(*)::int AS n FROM board_posts WHERE who_hash=$1 AND created_at > NOW() - INTERVAL '1 day'`, [who])).rows[0].n >= 3) return fail(res, 429, 'Daily limit reached. Please try again tomorrow.');
  const sid = b.sub_county ? await subId(b.sub_county) : null, token = crypto.randomBytes(16).toString('hex');
  const r = await db.query(`INSERT INTO board_posts(board,sub_county_id,title,summary,event_date,venue,contact_phone,extra,tier,status,fee_kes,token_hash,who_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [board, sid, title, summary, /^\d{4}-\d\d-\d\d$/.test(b.event_date || '') ? b.event_date : null, String(b.venue || '').slice(0, 120) || null, phone, clean, tier, fee > 0 ? 'awaiting_payment' : 'pending', fee, hash(token), who]);
  const id = r.rows[0].id;
  if (fee > 0) {
    try { await makeCharge('board', id, pay, fee, title, 'Notice fee'); }
    catch (e) { console.error(e.response?.data || e.message); await db.query(`UPDATE board_posts SET status='removed', removed_reason='payment failed to start' WHERE id=$1`, [id]); return fail(res, 502, 'Could not start the payment. Try again.'); }
  }
  res.status(201).json({ id, token, fee, message: fee > 0 ? `Check your phone for the KSh ${fee} M-Pesa prompt. After payment our team reviews your notice before it is published.` : 'Received. Our team will review it before it is published.' });
});
app.post('/api/boards/:id/photo', boardLimit, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1500kb' }), async (req, res) => {
  const b = req.body, p = (await db.query(`SELECT id FROM board_posts WHERE id=$1 AND token_hash=$2 AND board IN ('memorial','celebration','lostfound','missing') AND photo_url IS NULL`, [req.params.id, hash(req.get('x-board-token') || '')])).rows[0];
  if (!p || !Buffer.isBuffer(b) || b.length < 100 || !imgExt(b)) return fail(res, 400, 'Photo not accepted');
  await db.query('UPDATE board_posts SET photo_url=$2 WHERE id=$1', [p.id, saveImg(b, imgExt(b))]); res.json({ ok: true });
});
app.get('/api/boards', async (req, res) => {
  const board = ['memorial', 'celebration', 'legal', 'lostfound', 'missing', 'chama', 'coroner'].includes(req.query.board) ? req.query.board : null;
  if (!board) return fail(res, 400, 'Choose a board');
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null, q = req.query.q ? `%${String(req.query.q).replace(/[%_]/g, '')}%` : null;
  const rows = (await db.query(`SELECT id, title, summary, event_date, venue, photo_url, tier, published_at, expires_on, print_edition, extra, confirmed_at IS NOT NULL AS confirmed,
      CASE WHEN board <> 'celebration' THEN contact_phone END AS contact
    FROM board_posts WHERE board=$1 AND status='published' AND expires_on >= CURRENT_DATE AND ($2::int IS NULL OR sub_county_id=$2 OR sub_county_id IS NULL) AND ($3::text IS NULL OR title ILIKE $3 OR summary ILIKE $3)
    ORDER BY (tier='featured') DESC, published_at DESC LIMIT 60`, [board, sid, q])).rows;
  rows.forEach(r => { if (!r.confirmed) { delete r.extra.paybill; delete r.extra.paybill_name; } if (board === 'missing' && r.extra.photo_consent !== 'yes') r.photo_url = null; });   // contribution numbers show only once we have phoned the family; missing-person photos only with consent
  res.json(rows);
});
const boardScope = (u, r) => staffOnly(u) || (u.role === 'hub_lead' && !['legal', 'missing', 'coroner'].includes(r.board) && (r.sub_county_id === null || r.sub_county_id === u.sub_county_id));
const loadBoard = async id => (await db.query('SELECT id, board, tier, status, paid, fee_kes, sub_county_id, confirmed_at FROM board_posts WHERE id=$1', [id])).rows[0];
app.get('/api/desk/boards', crew, async (req, res) => {
  const u = req.user, st = req.query.status === 'published' ? 'published' : 'pending';
  res.json((await db.query(`SELECT b.id, b.board, b.title, b.summary, b.event_date, b.venue, b.contact_phone, b.extra, b.tier, b.status, b.fee_kes, b.paid, b.confirmed_at, b.confirm_note, b.published_at, b.expires_on, b.print_edition, b.photo_url, b.created_at, sc.name AS area
    FROM board_posts b LEFT JOIN sub_counties sc ON sc.id=b.sub_county_id WHERE b.status=$1 AND ($2::int IS NULL OR b.sub_county_id=$2 OR b.sub_county_id IS NULL) AND ($3 OR b.board NOT IN ('legal','missing','coroner'))
    ORDER BY b.created_at DESC LIMIT 50`, [st, u.role === 'hub_lead' ? u.sub_county_id : null, staffOnly(u)])).rows);
});
app.post('/api/desk/boards/:id/confirm', crew, async (req, res) => {              // someone on the team phoned the family or the advocate and checked
  const r = await loadBoard(req.params.id);
  if (!r || !boardScope(req.user, r)) return fail(res, 404, 'Not found');
  await db.query('UPDATE board_posts SET confirmed_at=NOW(), confirmed_by=$2, confirm_note=$3 WHERE id=$1', [r.id, req.user.id, String(req.body?.note || '').slice(0, 200) || null]);
  log(req.user, 'board_confirmed', String(r.id)); res.json({ ok: true });
});
app.post('/api/desk/boards/:id/publish', crew, async (req, res) => {
  const r = await loadBoard(req.params.id);
  if (!r || !boardScope(req.user, r)) return fail(res, 404, 'Not found');
  if (r.status !== 'pending') return fail(res, 400, r.status === 'awaiting_payment' ? 'Payment has not been received yet' : 'Already handled');
  if (!['celebration', 'lostfound'].includes(r.board) && !r.confirmed_at) return fail(res, 400, 'Phone the family, advocate or contact and press Confirm first');
  const days = Math.min(Math.max(parseInt(req.body?.run_days, 10) || (r.board === 'celebration' ? RUNDAYS[r.tier] : RUNDAYS[r.board]), 1), 365);
  await db.query(`UPDATE board_posts SET status='published', published_at=NOW(), expires_on=CURRENT_DATE + $2::int,
    content_hash=encode(sha256(convert_to(title || '|' || summary || '|' || extra::text || '|' || NOW()::text, 'UTF8')), 'hex') WHERE id=$1`, [r.id, days]);
  if (req.body?.featured && staffOnly(req.user) && ['chama', 'celebration'].includes(r.board)) await db.query(`UPDATE board_posts SET tier='featured' WHERE id=$1`, [r.id]);
  log(req.user, 'board_published', String(r.id), `${r.board}, ${days} days`); res.json({ ok: true, days });
});
app.post('/api/desk/boards/:id/remove', crew, async (req, res) => {
  const r = await loadBoard(req.params.id);
  if (!r || !boardScope(req.user, r)) return fail(res, 404, 'Not found');
  await db.query(`UPDATE board_posts SET status='removed', removed_reason=$2 WHERE id=$1`, [r.id, String(req.body?.reason || '').slice(0, 200) || null]);
  log(req.user, 'board_removed', String(r.id), req.body?.reason); res.json({ ok: true });
});
app.post('/api/desk/boards/stamp-print', admin, async (req, res) => {              // record that live legal notices are in a printed edition
  const ed = String(req.body?.edition || '').trim().slice(0, 60), sid = req.body?.sub_county ? await subId(req.body.sub_county) : null;
  if (!ed) return fail(res, 400, 'Type the edition label first');
  const r = await db.query(`UPDATE board_posts SET print_edition=$1 WHERE board='legal' AND status='published' AND expires_on >= CURRENT_DATE AND print_edition IS NULL AND ($2::int IS NULL OR sub_county_id=$2 OR sub_county_id IS NULL)`, [ed, sid]);
  log(req.user, 'legal_stamped_in_print', ed, `${r.rowCount} notices`); res.json({ stamped: r.rowCount });
});
app.get('/api/boards/:id/certificate', async (req, res) => {                        // facts only; it never says a notice is legally effective
  const id = Number(req.params.id);
  let ok = req.query.t ? (await db.query('SELECT 1 FROM board_posts WHERE id=$1 AND token_hash=$2', [id, hash(String(req.query.t))])).rowCount > 0 : false;
  if (!ok) { const k = req.get('x-api-key') || ''; ok = !!k && (await db.query(`SELECT 1 FROM users WHERE key_hash=$1 AND active AND NOT frozen AND role IN ('owner','editor')`, [hash(k)])).rowCount > 0; }
  if (!ok) return fail(res, 404, 'Certificate not found');
  const r = (await db.query(`SELECT b.id, b.title, b.summary, b.extra, b.published_at, b.expires_on, b.content_hash, b.print_edition, b.sub_county_id, sc.name AS area
    FROM board_posts b LEFT JOIN sub_counties sc ON sc.id=b.sub_county_id WHERE b.id=$1 AND b.board='legal' AND b.status='published'`, [id])).rows[0];
  if (!r) return fail(res, 404, 'Only published legal notices have a certificate');
  const views = (await db.query(`SELECT COUNT(*)::int AS n FROM events WHERE kind='page_view' AND ($1::int IS NULL OR sub_county_id=$1) AND created_at >= $2 AND created_at < LEAST(NOW(), $3::date + 1)`, [r.sub_county_id, r.published_at, r.expires_on])).rows[0].n;
  delete r.sub_county_id;
  res.json({ ...r, views_in_area: views, print_run: Number(E.PRINT_RUN || 10000), site: E.PUBLIC_URL || '', generated_at: new Date() });
});
// WhatsApp keyword helpers
async function waFares() {
  const r = await db.query(`SELECT from_place, to_place, mode, fare_kes, operator FROM fares WHERE active AND updated_at > NOW() - make_interval(days => 14) ORDER BY pinned DESC, from_place LIMIT 8`);
  return r.rows.length ? r.rows.map(f => `${f.from_place} to ${f.to_place} (${f.mode}${f.operator ? ', ' + f.operator : ''}): KSh ${f.fare_kes}`).join('\n') : 'No fares posted yet.';
}
async function waRoads() {
  const r = await db.query(`SELECT road, status, note FROM road_status WHERE updated_at > NOW() - INTERVAL '24 hours' ORDER BY CASE status WHEN 'heavy' THEN 0 WHEN 'patchy' THEN 1 ELSE 2 END`);
  return r.rows.length ? r.rows.map(x => `${x.road}: ${x.status === 'heavy' ? 'HEAVY FOG' : x.status.toUpperCase()}${x.note ? '. ' + x.note : ''}`).join('\n') : 'No road updates today.';
}
async function waClinics(sid) {
  const r = await db.query(`SELECT name, kind, phone, hours, open_24h FROM facilities WHERE active AND sub_county_id=$1 ORDER BY open_24h DESC, (featured_until >= CURRENT_DATE) DESC NULLS LAST, name LIMIT 8`, [sid]);
  return r.rows.length ? r.rows.map(f => `${f.name} (${f.kind})${f.open_24h ? ', open 24 hours' : f.hours ? ', ' + f.hours : ''}${f.phone ? ', +' + f.phone : ''}`).join('\n') : 'None listed yet.';
}
async function waBoard(board, sid) {
  const r = await db.query(`SELECT title, event_date, venue, extra FROM board_posts WHERE board=$1 AND status='published' AND expires_on >= CURRENT_DATE AND (sub_county_id=$2 OR sub_county_id IS NULL) ORDER BY published_at DESC LIMIT 5`, [board, sid]);
  return r.rows.length ? r.rows.map(x => board === 'legal' ? `${x.title}${x.extra.case_no ? ' (' + x.extra.case_no + ', ' + (x.extra.court || '') + ')' : ''}` : `${x.title}${x.event_date ? ', ' + String(x.event_date).slice(0, 10) : ''}${x.venue ? ' at ' + x.venue : ''}`).join('\n') : 'Nothing posted right now.';
}

// ---- Phase 7: more boards (lost and found, missing, chama, coroner) and the food and nightlife guide
const maskIf = (board, s) => ['lostfound', 'missing'].includes(board) ? s.replace(/\d{6,}/g, '••••') : s;      // long numbers (IDs, licences) are never published
app.post('/api/boards/:id/resolve', boardLimit, async (req, res) => {                                          // the person who posted a lost or found item can close it
  const r = await db.query(`UPDATE board_posts SET status='removed', removed_reason='resolved by poster' WHERE id=$1 AND board='lostfound' AND token_hash=$2 AND status='published' RETURNING id`, [req.params.id, hash(String(req.body?.t || ''))]);
  r.rowCount ? res.json({ ok: true }) : fail(res, 404, 'Notice not found or already closed');
});
app.post('/api/desk/boards/:id/status', admin, async (req, res) => {                                           // missing person: urgent, missing, or found (found removes the photo at once)
  const st = req.body?.status;
  if (!['missing', 'urgent', 'found'].includes(st)) return fail(res, 400, 'Choose missing, urgent or found');
  const r = await db.query(`UPDATE board_posts SET extra = extra || jsonb_build_object('case_status', $2::text)${st === 'found' ? ', photo_url=NULL, expires_on=CURRENT_DATE + 7' : ''} WHERE id=$1 AND board='missing' AND status='published' RETURNING id`, [req.params.id, st]);
  if (!r.rowCount) return fail(res, 404, 'Notice not found'); log(req.user, 'missing_status', req.params.id, st); res.json({ ok: true });
});
app.post('/api/desk/boards/create', admin, async (req, res) => {                                               // coroner notices come only from the team, from an official source
  const b = req.body || {}, sid = b.sub_county ? await subId(b.sub_county) : null, phone = /^254\d{9}$/.test(b.contact_phone || '') ? b.contact_phone : null;
  const title = String(b.title || '').trim().slice(0, 150), summary = String(b.summary || '').trim().slice(0, 600), ex = b.extra || {};
  if (b.board !== 'coroner' || title.length < 3 || summary.length < 20 || !ex.ref || !ex.station || !phone || !String(b.venue || '').trim()) return fail(res, 400, 'Need a title, a non-graphic description, the mortuary, the police reference, the station and a phone');
  const days = Math.min(Math.max(parseInt(b.run_days, 10) || RUNDAYS.coroner, 1), 365), clean = {};
  for (const k of ['ref', 'station', 'admitted_on']) if (ex[k]) clean[k] = String(ex[k]).slice(0, 120);
  const r = await db.query(`INSERT INTO board_posts(board,sub_county_id,title,summary,venue,contact_phone,extra,status,token_hash,confirmed_at,confirmed_by,confirm_note,published_at,expires_on,content_hash)
    VALUES('coroner',$1,$2,$3,$4,$5,$6,'published',$7,NOW(),$8,'official source',NOW(),CURRENT_DATE + $9::int,$10) RETURNING id`,
    [sid, title, summary, String(b.venue).trim().slice(0, 120), phone, clean, hash(crypto.randomBytes(8).toString('hex')), req.user.id, days, hash(title + summary + JSON.stringify(clean) + Date.now())]);
  log(req.user, 'coroner_notice_published', String(r.rows[0].id), title); res.status(201).json({ id: r.rows[0].id });
});
async function waBoard2(board, sid) {
  const r = await db.query(`SELECT title, summary, venue, event_date, extra, contact_phone FROM board_posts WHERE board=$1 AND status='published' AND expires_on >= CURRENT_DATE AND (sub_county_id=$2 OR sub_county_id IS NULL)
    ORDER BY (extra->>'case_status' = 'urgent') DESC NULLS LAST, published_at DESC LIMIT 6`, [board, sid]);
  if (!r.rows.length) return 'Nothing posted right now.';
  return r.rows.map(x => board === 'missing' ? `${(x.extra.case_status || 'missing').toUpperCase()}: ${x.title}${x.extra.age ? ', ' + x.extra.age : ''}. Last seen ${x.extra.last_seen_place || 'unknown'}. Police OB ${x.extra.police_ob}, ${x.extra.police_station}. Contact +${x.contact_phone}`
    : board === 'lostfound' ? `${(x.extra.kind || '').toUpperCase()}: ${x.title}${x.venue ? ' at ' + x.venue : ''}. Contact +${x.contact_phone}`
    : `${x.title} (${x.extra.kind || 'group'})${x.extra.meets ? ', meets ' + x.extra.meets : ''}. Contact +${x.contact_phone}`).join('\n\n');
}

// K12 food, drink and nightlife guide: venues, menus, price comparison, paid promo line
app.get('/api/venues', async (req, res) => {
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  res.json((await db.query(`SELECT id, name, kind, address, phone, hours, description, menu_verified_at, CASE WHEN promo_until >= CURRENT_DATE THEN promo_text END AS promo FROM venues
    WHERE active AND ($1::int IS NULL OR sub_county_id=$1) AND ($2::text IS NULL OR kind=$2) ORDER BY (promo_until >= CURRENT_DATE) DESC NULLS LAST, name LIMIT 60`, [sid, req.query.kind || null])).rows);
});
app.get('/api/venues/:id/menu', async (req, res) => res.json((await db.query('SELECT id, item, price_kes, category, updated_at FROM menu_items WHERE venue_id=$1 AND active ORDER BY category, item', [req.params.id])).rows));
app.get('/api/menu/compare', async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/[%_]/g, '');
  if (q.length < 2) return res.json([]);
  const sid = req.query.sub_county ? await subId(req.query.sub_county) : null;
  res.json((await db.query(`SELECT m.item, m.price_kes, m.category, m.updated_at, v.name AS venue, v.kind FROM menu_items m JOIN venues v ON v.id=m.venue_id
    WHERE m.active AND v.active AND m.item ILIKE $1 AND ($2::int IS NULL OR v.sub_county_id=$2) ORDER BY m.price_kes, v.name LIMIT 40`, [`%${q}%`, sid])).rows);
});
app.post('/api/desk/venues', crew, async (req, res) => {
  const b = req.body || {}, sid = await scopeSid(req, b.sub_county);
  if (!sid || !String(b.name || '').trim() || !['restaurant', 'bar', 'club', 'lodge', 'cafe'].includes(b.kind)) return fail(res, 400, 'Need a name, a type and an area');
  if (b.phone && !/^254\d{9}$/.test(b.phone)) return fail(res, 400, 'Phone must look like 2547XXXXXXXX');
  const r = await db.query('INSERT INTO venues(name,kind,sub_county_id,address,phone,hours,description) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
    [b.name.trim().slice(0, 100), b.kind, sid, String(b.address || '').slice(0, 160) || null, b.phone || null, String(b.hours || '').slice(0, 80) || null, String(b.description || '').slice(0, 300) || null]);
  log(req.user, 'venue_added', String(r.rows[0].id), b.name); res.status(201).json({ id: r.rows[0].id });
});
const venueFor = async (req, res, id) => {
  const v = (await db.query('SELECT id, sub_county_id FROM venues WHERE id=$1 AND active', [id])).rows[0];
  if (!v || !areaOk(req.user, v.sub_county_id)) { fail(res, 404, 'Venue not found'); return null; }
  return v;
};
app.post('/api/desk/venues/:id/delete', crew, async (req, res) => {
  const v = await venueFor(req, res, req.params.id); if (!v) return;
  await db.query('UPDATE venues SET active=FALSE WHERE id=$1', [v.id]); res.json({ ok: true });
});
app.post('/api/desk/venues/:id/promo', admin, async (req, res) => {                  // a paid "tonight" line pinned to
