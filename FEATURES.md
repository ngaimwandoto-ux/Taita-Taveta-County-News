# Feature list (locked) and build order

**Rule: reading is always free.** No feature charges a reader for content or access. Money comes from businesses, advertisers, event organisers and institutions.

Status key: BUILT = in the current zip (untested live). LOCKED = agreed, not built. PARKED = discussed, not chosen.

## Already built
Free issue download, news by sub-county and paper, Today tab (prices vs Mombasa, roads, water and power, health, school, weather and farming), notices, guides and history in English or Kiswahili, search, video podcasts, story map with time filter, tap-to-chat business listings (KSh 600 by M-Pesa), WhatsApp card by keyword, offline reading, breaking tag, alerts, roles (owner, editor, hub lead, journalist), hashed keys, agreement on first sign-in, audit log, shared style.css.

## Phase 1: control and foundations (BUILT, untested live)
- A1 Replace a hub lead in one action (hub, journalists and stories stay)
- A2 Move a journalist or hub lead to another hub
- A3 Owner can edit or unpublish any story and change who is credited and paid
- A4 Freeze and unfreeze a hub or an editor instantly (nothing deleted)
- A5 Hand over a leaving editor's pending stories and fees to another editor
- A6 Backup owner or recovery code, so a lost master key doesn't lock you out
- B2 Edit a story after submission, every change logged (needed by A3, J4)
- E1 Photo upload from phones (needed by G1, J1)
- E2 Edit and expire prices, notices and listings (needed by G5, G6, I4)
- J4 Corrections log, shown publicly on the story

## Phase 2: field work (BUILT, untested live)
- J1 Offline story submission (drafts and photos saved on the phone, sent when signal returns)
- J3 Ping the hub lead when a draft arrives (SMS or WhatsApp)
- G1 Reader tips by WhatsApp or app, landing in the right hub's queue

## Phase 3: the two voices and readers (BUILT, untested live)
- H1 Paired stories: a Review story linked to Roundup's rebuttal, shown side by side
- H2 Reader vote on the week's winning argument
- G2 "Is this true?" rumour desk with verified replies
- G3 Job and tender alerts by WhatsApp keyword
- G4 School results lookup page (school averages only; no individual candidate data)
- G5 Market-day calendar and trader directory
- G6 Local sports: fixtures, results, league tables entered by hubs

## Phase 4: money (BUILT, untested live)
- I1 Verified business badge (yearly fee)
- I3 Event ticketing by M-Pesa
- I4 Live rate card and advertiser report (scans, taps, plays, readers). Merged with C4
- I5 Insight subscriptions for NGOs and county planners (aggregated, anonymous only)

## Phase 5: print (BUILT, untested live)
- J2 Print supplement generator: approved stories into a print-ready PDF for the 10,000 copies

## Launch tasks (F)
- F1 You: county boundary file, three font files, app icons
- F2 You: M-Pesa sandbox test, then live approval from Safaricom
- F3 You and a lawyer: contributor and advertiser agreements, data-protection registration check
- F4 Me: step-by-step hosting deployment guide (written at the end of Phase 1)

## Phase 6: daily utilities and notice boards (BUILT, untested live)
K1 transport fares, K2 clinics and pharmacies, K3 road and fog status, K4 commodity extras (more items, price trend; sponsored supplier slots not built), K5 bursary, participation and announcement notices, K7 obituaries and memorials, K8 celebrations with vendor directory, K13 legal notices with certificate of publication.
## Phase 7: remaining community modules (BUILT, untested live)
K6 legal-services directory, K9 lost and found, K10 missing persons, K11 chama directory, K12 food and nightlife guide, K14 unclaimed-body notices. Built with product safeguards (verification calls, consent for photos, hidden long numbers, official-source-only coroner notices). Legal definitions, licences and registrations are deferred by decision and must be settled before relying on them.

## Dropped (breaks the free-reader rule)
J5 SMS fallback (reader would pay for texts), C3 supporter tier.

## Parked (not chosen)
B1 phone passkeys, H3 separate hubs per paper, B3 monthly hub fee statement, B4 WhatsApp invite links, C1 topic sponsorships, C2 paid notices, D1 tracked social links, D2 shareable story previews, D3 daily price card image, D4 WhatsApp morning broadcast, D5 full Kiswahili interface, E3 issue PDF upload from the desk, E4 archive page, I2 coupons.

## Accounts and costs to arrange early
- Safaricom Daraja (M-Pesa): approval takes time
- Meta WhatsApp Business: verification takes days; templates need approval
- SMS provider with a sender name (cost per message), for J3 hub-lead pings only
- Hosting with Node, PostgreSQL, https and daily backups

## Risks to remember
- J1 offline: works well on Android; iPhones are limited, so keep a "send now" button
- G1, G2, G3, J3 over WhatsApp need spam and abuse filtering; first contact needs approved templates
- I5 insights must stay aggregated; check against data-protection rules
- Without H3, Review and Roundup share the same hubs and reporters. Keeping the two voices distinct depends on the editors and on H1 (paired stories)
