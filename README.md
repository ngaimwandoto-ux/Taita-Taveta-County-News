# Taita Taveta County Review & Roundup: digital platform

A mobile-first news and daily-utility app (PWA) for two rival-voice papers, **The County Review** and **County Roundup**. Free issues, local video podcasts, daily prices and notices, and a KSh 600 self-service business listing paid by M-Pesa.

> **Status: first working draft.** The code passes syntax checks but has not been run end to end against a live database or the M-Pesa API. Test on the Safaricom sandbox before charging anyone.

## What's inside

```
county-media/
  server.js              Backend (Node + Express + PostgreSQL)
  package.json           Dependencies
  .env.example           Settings to copy into .env
  schema.sql             Base database (run first)
  schema_v2.sql          Contributor keys
  schema_v3.sql          Video podcast episodes
  schema_v4.sql          Notices, alerts, guides, business categories
  schema_v5.sql          WhatsApp users and opt-ins
  schema_v6.sql          Story map pins
  schema_v7.sql          Breaking tag
  schema_v8.sql          Accounts, hubs, roles, audit log
  schema_v9.sql          Freezes, recovery, edit history, corrections
  schema_v10.sql         Duplicate-proof submissions, reader tips
  schema_v11.sql         Paired stories and votes, fact-checks, results, markets, traders, sport
  schema_v12.sql         Verified badge, ticketing, rates, reports, insight subscriptions
  schema_v13.sql         Optional full story text
  schema_v14.sql         Lead story
  schema_v15.sql         Fares, clinics, road status, memorial / celebration / legal boards
  schema_v16.sql         Lost and found, missing persons, chamas, coroner notices, food and nightlife guide
  DEPLOY.md              Hosting guide
  FEATURES.md            Locked feature list and phases
  uploads/               Photos uploaded from phones (back this up)
  scripts/recover.js     Restores your master key from a recovery code
  scripts/create-owner.js  Creates YOUR master key (run once)
  public/
    style.css            The one stylesheet every page uses (the design rulebook)
    index.html           Reader app (Today, News, Notices, Learn, Shows, Map)
    taita-taveta.geojson YOU ADD: county boundary for the map (see Story map)
    subcounties.geojson  OPTIONAL: sub-county boundaries (name in properties.name)
    tip.html             Reader tip form
    biashara.html        Business signup and M-Pesa payment page
    desk.html            Editor and contributor screen
    sw.js                Offline caching
    manifest.webmanifest Install-to-home-screen settings
    issues/              Put each month's issue here as latest.pdf
```

## Set-up

1. Install **Node 18+** and **PostgreSQL**. Create a database, for example `county_media`.
2. Run the schema files **in order**: `schema.sql`, `schema_v2.sql`, `schema_v3.sql`, `schema_v4.sql`, `schema_v5.sql`, `schema_v6.sql`, `schema_v7.sql`, `schema_v8.sql`, `schema_v9.sql`, `schema_v10.sql`, `schema_v11.sql`, `schema_v12.sql`, `schema_v13.sql`, `schema_v14.sql`, `schema_v15.sql`, `schema_v16.sql`.
3. Copy `.env.example` to `.env` and fill it in (see below).
4. `npm install`, then `npm start`. The app runs on port 3000.
5. Add before launch: `public/icon-192.png`, `public/icon-512.png` (app icons, required for install), and `public/issues/latest.pdf`.

Load the `.env` values with your host's settings or a tool such as `node --env-file=.env server.js`.

### Settings (`.env`)

| Setting | What it is |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `MPESA_BASE` | `https://sandbox.safaricom.co.ke` for testing, the live URL once approved |
| `MPESA_KEY`, `MPESA_SECRET` | From your Safaricom Daraja app |
| `MPESA_SHORTCODE`, `MPESA_PASSKEY` | Your paybill/till details |
| `MPESA_CALLBACK_SECRET` | Random text. It becomes part of the callback URL |
| `PUBLIC_URL` | Your public https address (M-Pesa must be able to reach it) |
| `AD_PRICE_KES`, `AD_DAYS` | Listing price and length (600 and 14) |
| `BADGE_PRICE_KES`, `BADGE_DAYS` | Verified badge price and length (2000 and 365; set your own) |
| `MEMORIAL_FEE_KES`, `CELEBRATION_BASIC_KES`, `CELEBRATION_FEATURED_KES`, `LEGAL_FEE_KES` | Fees for the notice boards (500, 0, 500, 3000 are placeholders: set your own) |
| `PRINT_RUN` | Your print run, shown on certificates of publication (10000) |
| `PUBLIC_CONTACT` | Your WhatsApp number (2547XXXXXXXX), shown on the advertise page |
| `SMS_USER`, `SMS_KEY`, `SMS_FROM`, `SMS_URL` | Optional SMS provider for hub-lead pings (defaults match Africa's Talking; check your provider's docs) |
| `WA_TOKEN`, `WA_PHONE_ID` | WhatsApp Cloud API access token and phone number ID (Meta) |
| `WA_VERIFY_TOKEN`, `WA_APP_SECRET` | Random text you choose, and your Meta app secret (used to check messages are genuine) |

## Daily use

- **Owner and staff:** see Accounts, hubs and keys below. Staff sign in at `/desk.html` with their personal key.
- **Journalists and hub leads:** each person has their own key (shown once when created). Journalists submit stories; nothing goes live until a hub lead (daily feed only) or an editor approves it.
- **Contributor pay:** approve a story with a fee. Unpaid fees show with the contributor's M-Pesa number, and you mark them paid after sending the money yourself (no automatic payout yet).
- **Businesses:** send them to `/biashara.html`. They pay KSh 600 and appear for 14 days.
- **QR posters:** point each poster at `/q/<poster-name>` (for example `/q/voi-stage-1`). Each scan is counted, then the reader goes to the app.
- **Podcasts:** paste a YouTube link (recommended, no hosting cost) or a direct .mp4 link.

## Accounts, hubs and keys

Four levels. Each level can create and switch off only the level directly below, so your master key never leaves you.

| Level | Created by | Can do |
|---|---|---|
| **Owner** (you) | the `npm run owner` script | Everything. Creates editors, hubs, and sees the activity log |
| **Editor** | owner | Approves stories, sets fees and breaking tags, posts prices, notices, podcasts, alerts. Creates hub leads and journalists |
| **Hub lead** (one per cell) | owner or editor | Reviews their own hub's drafts: publishes daily-feed stories directly, passes main-issue stories to the editor, rejects. Creates and switches off their own journalists |
| **Journalist** | hub lead, editor or owner | Submits stories, sees their own stories and fee status |

Set-up: run `schema_v8.sql`, then `DATABASE_URL=... npm run owner -- "Your Name"`. It prints your master key once; store it somewhere safe. Existing contributors are carried over with their keys intact (now hashed), each assigned to a hub for their sub-county.

Rules built in: every person accepts the contributor agreement on first sign-in (date saved). Every action (submit, approve, reject, fee, key issued, switch off) is recorded in the activity log (owner only). Hub leads can't set fees; the editor does, so the money stays in two hands. An editor can't touch the owner, and a hub lead can't touch another hub.

Owner powers: replace a hub lead in one action, move people between hubs, freeze or unfreeze a person or a hub, hand a leaving editor's unpaid fees and accounts to another editor, edit or unpublish any story, change who is credited and paid, and create a recovery code. If you lose your master key: `DATABASE_URL=... npm run recover -- <recovery code>`.

Editing and corrections: stories can be edited after submission (every change is logged). On published stories an editor can add a correction note, shown publicly on the story. Photos are uploaded from the phone (shrunk first, which also strips location data) and stored in `uploads/`. Prices not updated for 7 days are hidden automatically.

Not built yet: phone passkeys (fingerprint sign-in) and a monthly fee statement per hub.

## Field work: offline stories, pings and reader tips

- **Offline writing.** Journalists tick "Keep me signed in on this phone" once. After that, `/desk.html` opens without signal, and stories (with photos) are saved on the phone and sent automatically when signal returns. A "Waiting to send" list shows what is queued, with Send now and Discard. Each story carries a unique ID, so a story sent twice is never duplicated. Works best on Android; on iPhone, open the desk and tap Send now when you have signal, because iPhones may pause background sending. Don't tick "keep me signed in" on shared phones.
- **Pings.** When a journalist submits a draft or a reader sends a tip, the hub lead gets an SMS (at most one every 10 minutes, to control cost). It goes to the number on the lead's account and needs the optional SMS settings in `.env`; without them nothing is sent and the queue still works.
- **Reader tips.** Readers use `/tip.html` (linked from the app) or WhatsApp: message `TIP` or `RIPOTI` followed by what happened, then send a photo within 10 minutes. Tips land in the right hub's Tips tab, where hub leads and editors can assign them to a journalist, mark them used, or flag spam. Names are never published. Spam protection: hidden bot trap, rate limits, a limit of 5 tips a day per person, and a cap on links. Tip photos are visible only on the desk, never public.

## Readers and community (Phase 3)

All of this lives in the Notices tab (the section picker) or the News tab, and in the desk's Community tab.

- **They say, we say.** In the desk's Published tab, an editor pairs a story with its rebuttal. Readers see them together as one face-off with a switch between the two sides, then a poll: "Which side convinced you?" Results show after they vote. Votes are one per device per pair; it is a casual poll, not tamper-proof (many phones share one network address, so it counts devices, not locations). The News tab shows "Readers' pick this week".
- **Fact checks.** Readers send a rumour at `/check.html` or by WhatsApp (`CHECK` or `KAGUA` plus the claim). It appears in the desk Tips tab marked CLAIM TO CHECK. An editor picks a verdict (true, false, misleading, not verified), writes the answer, and it is published under Notices, Fact checks.
- **Jobs, tenders, events, fact checks, sport, markets by WhatsApp.** `JOBS` or `KAZI`, `TENDERS` or `ZABUNI`, `EVENTS` or `MATUKIO`, `FACTS` or `UKWELI`, `SPORTS` or `MICHEZO`, `MARKET` or `SOKO`. These are replies when a person asks. Pushing alerts without being asked needs Meta-approved templates, which are not built.
- **School results.** The desk imports school averages (KCPE or KCSE) from pasted lines: school, candidates, mean score, mean grade. Readers search by school. Individual candidate results are deliberately not stored: they are children's personal data and are available from the official exam channels.
- **Market days and traders.** Hub leads and editors enter market days and a free trader directory (only with the trader's consent). Readers see today's markets highlighted and tap Chat to reach a trader.
- **Local sport.** Hub leads and editors create leagues, add fixtures and enter scores. The league table is worked out automatically (3 points for a win, 1 for a draw), shown with next fixtures and recent results.

## Money (Phase 4)

Readers never pay. Money comes from businesses, organisers and institutions.

- **Verified badge** (`/verify.html`). A business with an active listing pays the yearly fee by M-Pesa. Then your team checks the business (call or visit) and ticks "Mark as verified" in the desk's Tools tab, under Business listings. The badge shows only when both the payment and your check are done, and verified businesses are listed first. Refunds if you decline are manual.
- **Event ticketing** (Notices, "Events and tickets"). In the desk's Money tab you create an event (price, capacity, organiser, your commission %). Readers buy up to 5 tickets by M-Pesa and get an 8-character code (kept on their phone under My tickets). Free events issue codes immediately. At the door, anyone signed in uses Community, Door check-in: a code works once. The Money tab shows takings, your commission and what you owe the organiser; you pay them yourself and press Mark organiser as paid. The paper holds the buyers' money until then, so take advice on the legal and tax side of that. If a payment went through but the tickets never confirmed, a staff member can use "Mark this ticket paid" with the M-Pesa receipt number. Held tickets expire after 10 minutes if unpaid.
- **Rates, audience numbers and reports.** `/advertise.html` is a public page showing your live 30-day numbers (feed views, QR scans, installs, issue downloads, video plays, taps, WhatsApp, active listings) beside your rates. Add your own rates in the Money tab; the listing and badge prices appear automatically. Views are page loads, not unique people, and the page says so. Each business listing has its own private report link (shown in the desk, under Business listings) at `/report.html?t=...` showing taps on its Chat button, which you can send them on WhatsApp.
- **Insight subscriptions** (`/insights.html`). For NGOs, planners and agribusiness. In the Money tab, create a subscription (organisation, months). It gives a key shown once, and they open the insights page with it. Data: weekly average market prices against Mombasa (history starts when you run schema_v12 and keep entering prices), reader attention by area (counts under 10 hidden), published stories by topic, and fact-checks by verdict, with CSV download. Only aggregated, anonymous data is shared. Invoice them yourself. Check the data-protection rules before selling.

## Print supplement (Phase 5)

Stories can carry an optional **full story** (the Write and Edit forms have a box for it). In the app, readers see the three short points and a "Read full story" button that loads the text only when tapped, so it costs no data until asked for. The printed supplement uses the full text where there is one, otherwise the three points.

To make an edition: desk, Print tab. Choose the area (or whole county), how many days back, page size (A3, A4 or Tabloid), masthead, edition label and ink (black and white or colour). Press Show stories, tick the ones you want (main-issue stories are pre-ticked) and pick the lead story, then Open print layout. A new page shows the supplement: masthead, lead story, the other stories in columns, a "They say, we say" page for paired stories, market prices (all four sub-counties side by side for a county edition), market days, sport results and table, jobs, tenders, events and notices, the business directory (verified first), and a back page with QR codes and two advert slots. Press Print, choose Save as PDF, and send the file to your printer.

Things to know: the page flows into columns automatically, so check the preview and page breaks before sending, and shorten or drop stories if it runs over. Output is a normal screen-colour PDF. Ask your printer whether they need CMYK, bleed or a particular page size. QR codes need an internet connection the first time (the library is loaded from cdnjs); to avoid that, download `qrcode.min.js` (the "qrcode-generator" library) into `public/vendor/`. If QR codes can't load, the page shows a dashed box and the web address instead. Every QR points to a tracked address (`/q/print-<edition>`), so you can see how many people scanned the printed copy.

## The main page and its lead story

The main page (Today tab) opens with the day's lead story: a big full-width photo, the headline in large type, then the three points. The lead is chosen for the selected paper (Review or Roundup) and the logo above it matches. Editors choose it by ticking "Make this the lead story" when approving a story, or by pressing "Make lead story" on any published story in the Published tab. The most recent choice leads for 48 hours; after that the page falls back to the newest published story from the last 7 days that has a photo. A story needs a photo to lead. The paper tabs (The County Review, County Roundup) sit under the dateline on the main page and the News tab, and each paper shows only its own logo. Below the lead, a short "Also today in" block shows the other paper's lead and switches to that paper when tapped. The photo follows the grayscale-until-tapped rule like the others, and the Breaking tag shows above the headline when it applies.

## Daily utilities and notice boards (Phase 6)

All in the Notices tab, with the most-used pieces also on the main page (Today).

- **Roads and fog.** Hub leads and editors set each road to Clear, Patchy mist or Heavy fog, with a note. It shows at the top of Today (heavy fog in the red tag) and hides itself after 24 hours, so an old warning never misleads. WhatsApp: `ROADS` or `BARABARA`. "What to wear today" advice for the hills is posted as a Weather notice.
- **Transport fares.** Fares by route and mode (matatu, bus, SGR, boda, taxi), with an optional sacco name and booking WhatsApp. A paid sponsor can have its booking button pinned first. Fares not updated for 14 days disappear. WhatsApp: `FARES` or `NAULI`.
- **Clinics, hospitals and pharmacies.** A directory with a 24-hour roster, plus medical camps posted as Health notices. Editors can feature a listing for a set number of days (paid). WhatsApp: `CLINICS` or `ZAHANATI`.
- **Commodity extras.** More items in the daily price form (cattle, chicken, eggs, milk, beans) and an "Other item" line for things like gemstones. Readers tap a price to see its trend over recent weeks. Sponsored supplier slots under price rows are not built; sell them as a rate and place the business listing.
- **More notice types.** Bursaries, public participation and county announcements join the existing notice kinds.
- **Obituaries and memorials.** Families submit at `/board.html?b=memorial` (fee set in `.env`). Our team phones the family contact and presses Confirm before it can be published. A contribution paybill or till number is shown to readers only after that confirmation, marked "confirmed by us", to protect against scam numbers. WhatsApp: `RIP` or `MAZISHI`.
- **Celebrations.** Basic (a short line, free by default) and Featured (photo, longer message, pinned for a week). Below the board, vendors from the business directory (bakery, decor, catering, photography, florist, gifts) are shown. Get a parent's consent before posting photos of children.
- **Legal notices (supporting layer).** Only advocates or authorised process servers can submit, with the case number, court, order date and advocate name. Our team phones to verify, and only the owner or an editor can publish. Published notices are never edited: to correct one, remove it and publish a new one. Each carries a record fingerprint. The **Certificate of Publication** (`/certificate.html`) states facts only: the notice, publication and end dates, address, whether and where it was printed, the print run, and feed views in the area during the run. It never says the notice is legally effective. Position the paper as an addition to the court-ordered methods of service, and have a Kenyan advocate or court registrar confirm what Voi courts accept before you advertise it. In the Print tab, "Record live legal notices as printed in this edition" stamps the edition on the certificates, and the print layout includes legal notices, remembrance and celebrations. WhatsApp: `LEGAL` or `SHERIA`.

## More community modules (Phase 7)

All in the Notices tab; staff tools in the desk (Boards and Community tabs). Legal definitions, licences and registrations are deliberately left for later. The safeguards below are product choices, not legal advice.

- **Lost and found** (`/board.html?b=lostfound`). Free. Any run of six or more digits is hidden automatically, so IDs and licence numbers are never published. Our team checks each notice. Readers contact the poster by WhatsApp, and the poster can close their own notice with a private link. WhatsApp: `LOST` or `POTEA`.
- **Missing persons** (`/board.html?b=missing`). Free and ad-free. A submission needs the police OB number, the station and a contact phone. Only the owner or an editor can confirm and publish, after phoning to check. A photo is shown only when the family or police consented and we have confirmed. An editor can mark a case Urgent (red tag) or Found; Found removes the photo at once and the notice disappears after 7 days. The page tells readers to report to the police first. WhatsApp: `MISSING` or `KUPOTEA`.
- **Unclaimed bodies notices.** Created only by the owner or an editor from an official source (mortuary or police), with a police reference, plain non-graphic wording and no photos. Not open to public submission.
- **Chama directory** (`/board.html?b=chama`). Free, opt-in. Hub leads or editors confirm by phone and publish; editors can feature a group. "Ask to join" opens WhatsApp to the group's contact with a pre-filled message. The page states that we do not audit any group or vouch for finances. There are no audit seals or "healthy" badges. WhatsApp: `CHAMA`.
- **Legal services directory.** Process servers, legal runners and advocates use the normal paid business listing (choose that category at `/biashara.html`) and appear in their own section, verified first.
- **Food, drink and nightlife guide.** Hub leads and editors add venues and menu items (Community tab). Readers browse venues, open a menu (shown with the date it was last checked), and compare prices ("tusker", "nyama choma", "chai"). Editors can pin a paid "Tonight" line for 1 to 30 days. The page carries an 18+ drinking notice. Alcohol advertising rules are for you to check before selling brand placements.

Still to do on your side before relying on these: confirm the rules for missing-person and coroner information, chama listings, and alcohol promotion with an advocate, and check data-protection registration.

## WhatsApp daily card

People message your WhatsApp Business number and get a card for their sub-county: alerts, prices (with Mombasa), roads, top stories. Keywords: a town name, `NEWS`/`HABARI`, `PRICES`/`BEI`, `ALERTS`/`TAHADHARI`, `KISWAHILI`/`ENGLISH`, `SUBSCRIBE`/`JIUNGE`, `STOP`/`ACHA`.

Set-up (official Meta route):
1. Create a Meta developer app, add the **WhatsApp** product, and a business phone number (business verification may be needed).
2. Put the token, phone number ID and app secret in `.env`.
3. In Meta's WhatsApp settings set the webhook URL to `https://your-domain/api/whatsapp`, with your `WA_VERIFY_TOKEN`, and subscribe to **messages**.
4. Message your number to test. Replies within 24 hours of a person's message are free-form. **Sending first** (daily broadcasts) needs Meta-approved message templates and per-conversation fees, which are not built yet. Subscribers are saved in `wa_users` for that step.

Note: the connection only accepts messages signed by Meta. Unofficial WhatsApp services (such as Whapi.cloud) work differently and risk the number being banned, so this build does not use them.

## Putting the project on GitHub

1. **Make the repository private** on GitHub (New repository, Private). The code holds no secrets, but there is no reason to publish your business logic. No licence file is included on purpose: until you add one, nobody else may reuse the code.
2. **Never commit secrets.** `.gitignore` already excludes `.env`, `node_modules/`, uploaded photos, monthly issue PDFs and backups. Before your first commit, run `git status` and confirm `.env` is not listed. Your master key, M-Pesa keys, WhatsApp token and database password must never appear in the repository, in issues, or in chat messages. If one ever does, treat it as stolen: replace it (new key, new token) at once.
3. From the project folder:
```
git init
git add .
git status
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git
git push -u origin main
```
4. Run `npm install` once on your computer first and commit the `package-lock.json` it creates, so the server installs exactly the same versions.
5. Things that stay out of GitHub and must be put on the server by hand: `.env`, the `uploads/` photos, and each month's `public/issues/latest.pdf`. Everything else (fonts, icons, logos, the county boundary file) can be committed.
6. Turn on GitHub's secret scanning and two-factor sign-in for your account.

**Deploying from GitHub to the server:** on the server, create a read-only *deploy key* (`ssh-keygen -t ed25519`, then add the public key under the repository's Settings, Deploy keys), then `git clone git@github.com:YOUR_USER/YOUR_REPO.git county-media`. To update later: `git pull`, `npm install --omit=dev`, run any new `schema_vN.sql`, then `pm2 restart county-media`.

## Look and fonts

One stylesheet, `public/style.css`, controls every page. Rules: only your logo orange (#E8690F) and green (#1B5510) plus neutrals; **red (#C8102E) appears only on the "Breaking" tag and alerts**; the map and price arrows are the only places with other colours; square corners, no cards, hairline rules; light theme only.

Fonts are Zilla Slab (headlines, labels, numbers) and Literata (story text), both open licence. Add these files to `public/fonts/`: `ZillaSlab-Bold.woff2`, `Literata-Regular.woff2`, `Literata-Bold.woff2`. Without them the app falls back to each phone's own serif and still works, but the look will be plainer.

**Breaking tag:** the editor ticks "Mark as breaking" when approving a story. The red tag shows before its headline for 24 hours, then disappears.

## Story map

Every story carries a latitude/longitude pin (set by the contributor with "Use my location", corrected by the editor on approval, or defaulted to the sub-county's town centre). The **Map** tab draws the pins on the county outline, coloured by topic, filtered by time period (today, 7 or 30 days, a year, all time, or custom dates). Tap a pin to read the story. Active businesses with locations also appear. The map uses an equal-scale projection with latitude/longitude grid lines, so pins land where they should, and it works offline.

**You must add the county boundary.** Until you do, the map shows a dashed box and a red "Boundary file not added yet" note.
1. Get the Taita Taveta county boundary from an open source (OpenStreetMap, GADM level 1 for Kenya, or Kenya's open county boundary data) as a GeoJSON file.
2. Simplify it to a few hundred points at [mapshaper.org](https://mapshaper.org) (Simplify, then Export as GeoJSON) so it stays under about 50 KB.
3. Save it as `public/taita-taveta.geojson`. The map fits itself to it automatically.
4. Optional: save sub-county boundaries as `public/subcounties.geojson`, with each feature's `properties.name` set (for example "Voi"). They are drawn as fine lines inside the county.

Town centres used for default pins are approximate. Check them, and the reference towns at the top of `server.js` and `index.html`, against a trusted source.

## Pages and main routes

| Page / route | Purpose |
|---|---|
| `/` | Reader app |
| `/desk.html` | Editor and contributor screen |
| `/biashara.html` | Business signup |
| `/q/:poster` | Counts a QR scan, then opens the app |
| `GET /api/feed/:subcounty` | Stories, prices, businesses |
| `GET /api/utility/:subcounty` | Notices, guides, advisories |
| `GET /api/alerts`, `/api/podcasts`, `/api/search` | Alerts, episodes, search |
| `/api/desk/*`, `POST /api/bureau/stories` | Editor and contributor actions (key required) |
| `POST /api/biashara/register` | Starts the M-Pesa payment |
| `POST /api/mpesa-callback/:secret` | Safaricom's payment confirmation |
| `GET /api/map` | Story and business pins, by period and topic |
| `/api/whatsapp` | WhatsApp webhook (Meta verifies and sends messages here) |

## Security notes

- Keys are stored hashed. Your master key is shown once when you create it and can't be recovered. Never give it to anyone: create an editor account instead. Serve the site over **https** only.
- If a key leaks or a phone is lost, use Issue new key (old one stops working at once) or Switch off.
- Rate limits are on. Reader pages show text safely (no raw HTML from the database).
- Back up the database regularly.

## Not built yet

WhatsApp broadcasts to subscribers (needs approved templates), Kiswahili for the whole interface (only guides switch language), automatic road, weather and fuel feeds, photo upload from phones, editing a story after it's submitted, automatic contributor payouts, paid notices, a supporter tier, admin screens for expiring or removing notices (for now, edit the database).

## Suggested field test

Give it to 10 to 15 traders, boda riders and farmers in Voi and Mwatate for a week, with real prices and notices loaded. Ask: which tab do you open first, what did you look for that wasn't there, and would you pay for a listing? Check the insights screen for which sections get used.

## Known gaps to check before launch

Test the full M-Pesa flow on the sandbox, run on a phone with weak data, confirm the licence and legal basis for publishing, and have a lawyer review the contributor and advertiser agreements.
