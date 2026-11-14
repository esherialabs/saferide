import { PRESS_COVERAGE } from './press';
import { PILOT_PHOTOS } from './pilotPhotos';
import { SPICE_FM_CLIP } from './media';
import { MODEL_VERSION, PARENT_ORG, PILOT } from './site';

export const INTERIOR_PAGES = {
  'what-we-do': {
    updatedAt: '2026-11-01',
    ogImage: '/og/what-we-do.jpg',
    evidenceTitle: 'What the app already does.',
    variant: 'manifesto',
    eyebrow: 'What we do',
    title: 'Private reporting, survivor control, and a Mombasa pilot.',
    intro:
      `SafeRide ran a supervised pilot with ${PILOT.partner} in ${PILOT.region}. The app supports a survivor-controlled journey: discreet entry, private drafts, evidence capture, support choices, consent review, and case tracking.`,
    heroTitle: 'An Android-first safety companion, not a hotline replacement.',
    heroBody:
      'SafeRide helps a rider document what happened, understand Kenyan support options, and decide whether to keep the record private, seek referral support, or prepare an escalation packet. Anonymous route signals remain a planned layer.',
    wideHeroTitle: true,
    tone: 'bg-[#50C9F0]',
    accent: 'bg-[#F7EC36]',
    image: PILOT_PHOTOS.communityBanner.src,
    imageAlt: PILOT_PHOTOS.communityBanner.alt,
    imagePosition: 'object-top',
    pilotStrip: {
      eyebrow: 'How the pilot ran',
      title: 'Briefing first, then the app.',
      intro:
        'The pilot opened with a briefing for the partner team: why most harassment is never reported, where the path to justice breaks, and the rule SafeRide is built on.',
      photos: [PILOT_PHOTOS.briefingGesture],
    },
    evidence: [
      {
        label: 'Mombasa pilot',
        title: 'SafeRide ran a supervised pilot.',
        body: `SafeRide ran a supervised pilot in October 2026 with ${PILOT.partner} in ${PILOT.region}.`,
      },
      {
        label: 'Mobile flow',
        title: 'Eight reporting screens are already mapped.',
        body: 'The app includes guided screens for a draft overview, evidence, what happened, where and when, support choices, consent review, and statement review.',
      },
      {
        label: 'Content pack',
        title: 'Rights and support content is local first.',
        body: 'Tips cover PEP, emergency contraception, 1195, P3 forms, evidence handling, counselling, privacy, and follow-up care before any network request is needed.',
      },
      {
        label: 'Pathways',
        title: 'The product separates private evidence from route accountability.',
        body: 'Anonymous map updates, referrals, and escalation packets are different choices, not one forced report path. The route index itself remains a planned layer, not a live score.',
      },
    ],
    stats: [
      { value: '4', label: 'product pathways; route mapping is not live' },
      { value: '20', label: 'offline tips and rights cards' },
      { value: '15', label: 'legal tags for incident structure' },
    ],
    cards: [
      {
        title: 'Report flow',
        body: 'The app guides a rider through a draft overview, evidence, incident details, support choices, consent review, and statement review.',
      },
      {
        title: 'Support layer',
        body: 'The app includes tips on PEP, emergency contraception, 1195, P3 forms, evidence handling, psychosocial care, and survivor data control.',
      },
      {
        title: 'Accountability layer',
        body: 'Anonymous map updates and escalation forms are designed to separate survivor-controlled evidence from route-level prevention signals.',
      },
    ],
    stepsTitle: 'The product model',
    steps: [
      'Start with a local draft that can be saved, resumed, edited, or deleted.',
      'Collect optional media, notes, route context, timing, impact, witnesses, and legal tags.',
      'Choose a private, support, or escalation pathway before any data is shared; route mapping remains planned.',
      'Review exactly what leaves the device inside the consent gate before continuing.',
    ],
    faq: [
      { question: 'Is SafeRide an emergency service?', answer: 'No. The app informs without pretending to be emergency care. Survivor-facing copy keeps the medical, legal, police, counselling and emergency-service boundaries explicit.' },
      { question: 'Does a report leave my phone on its own?', answer: 'No. A report starts as a local draft. Referral and escalation paths need a review step before anything leaves the device.' },
      { question: 'Is there a public route map or safety score?', answer: 'No. Anonymous route mapping remains a planned layer, and no route score is published. Private evidence, support choices and route signals are kept separate.' },
      { question: 'Who develops SafeRide?', answer: `SafeRide is developed by ${PARENT_ORG.name}, the public-interest and social-impact initiative at esheria.org.` },
    ],
    ctaTitle: 'See how privacy and choice shape the reporting flow.',
    cta: { label: 'See how it works', href: '/how-it-works' },
  },
  'how-it-works': {
    updatedAt: '2026-11-01',
    ogImage: '/og/how-it-works.jpg',
    evidenceTitle: 'How the reporting flow protects riders.',
    variant: 'playbook',
    eyebrow: 'How it works',
    title: 'How to document and report harassment on a matatu — privately.',
    intro:
      'The workflow was tested in the supervised HURIA pilot in Mombasa. It was designed for a rider who may have low signal, low time, and high risk, so it started privately, recorded only what the user chose, and delayed sharing until the pathway was clear.',
    heroTitle: 'A structured path from incident to next step.',
    heroBody:
      'The reporting flow covers what happened, where and when, evidence, legal framing, pathway choice, consent review, referral selection, escalation details, and case status.',
    tone: 'bg-[#53E17C]',
    accent: 'bg-[#50C9F0]',
    image: '/images/how-it-works-consent-flow.webp',
    imageAlt: 'SafeRide Android incident draft, report steps, and case tracker screens',
    pilotStrip: {
      eyebrow: 'Testing the flow',
      title: 'Tried on real phones, with the team beside them.',
      intro:
        'The pilot ran in two stages: practice first, then live reporting with HURIA present.',
      photos: [PILOT_PHOTOS.liveDemoTalk],
    },
    evidence: [
      {
        label: 'Draft state',
        title: 'Progress is saved as the rider moves.',
        body: 'Draft utilities persist incident details, evidence metadata, location context, legal tags, pathway choice, and completion state.',
      },
      {
        label: 'Offline queue',
        title: 'Network-dependent work waits until it can sync.',
        body: 'The pilot build was designed to keep local draft work available and queue share or case actions rather than blocking the rider at the first weak signal.',
      },
      {
        label: 'Consent review',
        title: 'Sharing is a deliberate screen, not a hidden side effect.',
        body: 'Before referral or escalation, the user reviews what will be sent, where it goes, and what redaction level is applied.',
      },
    ],
    stats: [
      { value: '0', label: 'network required to begin a draft' },
      { value: 'Local', label: 'reports stay on the phone until the rider deletes them' },
      { value: '3', label: 'redaction levels for escalation packets' },
    ],
    cards: [
      {
        title: 'Capture and clarify',
        body: 'The draft can hold patterns, narrative, impact, witness details, route context, timing accuracy, media files, annotations, transcripts, and legal tags.',
      },
      {
        title: 'Pick a pathway',
        body: 'Save privately, get help through a hotline or provider, or escalate for operator/regulator action. Anonymous route mapping remains a planned layer.',
      },
      {
        title: 'Confirm consent',
        body: 'The consent screen summarizes when, where, what happened, attachments, tags, identity, provider, contact method, statement, and redactions before a referral or escalation.',
      },
    ],
    stepsTitle: 'The rider journey',
    steps: [
      'Open SafeRide directly or through stealth/decoy entry points when safety requires discretion.',
      'Start or resume a local incident draft and add only the details the rider feels safe recording.',
      'Use legal framing and rights content to understand possible categories without treating the app as legal advice.',
      'Select a pathway and review the consent checklist before a referral or escalation is prepared.',
    ],
    faq: [
      { question: 'Do I need a connection to start?', answer: 'No. A draft can be started with no network. Work that needs a connection waits in a queue rather than blocking you at the first weak signal.' },
      { question: 'What can a draft hold?', answer: 'Patterns, a narrative, impact, witness details, route context, timing accuracy, media files, annotations, transcripts and legal tags, all optional.' },
      { question: 'Can I stop and come back later?', answer: 'Yes. Progress is saved as you move, so a draft can be resumed, edited or deleted.' },
      { question: 'What does the consent screen show?', answer: 'What will be sent, where it goes and what redaction level applies: when, where, what happened, attachments, tags, identity, provider, contact method, statement and redactions.' },
    ],
    ctaTitle: 'See what the Mombasa pilot has already delivered.',
    cta: { label: 'Read the pilot update', href: '/impact' },
  },
  'for-survivors': {
    updatedAt: '2026-11-01',
    ogImage: '/og/for-survivors.jpg',
    evidenceTitle: 'Safety features built for survivors.',
    variant: 'playbook',
    eyebrow: 'For survivors',
    title: 'Support after harassment: your options in Kenya, at your pace.',
    intro:
      'SafeRide is not an emergency service, police service, lawyer, clinic, or counselling provider. It is a private tool for organizing information and deciding what support path feels safe.',
    heroTitle: 'No forced report. No hidden upload. No one-size-fits-all path.',
    heroBody:
      'The app lets a rider keep everything on the phone, prepare a limited support brief, or prepare a structured escalation packet. Anonymous route information remains a planned layer.',
    tone: 'bg-[#F88539]',
    accent: 'bg-[#53E17C]',
    image: '/images/story-origin-nairobi.webp',
    imageAlt: 'Women commuters crossing a busy Nairobi matatu stage at sunset, with buses and a billboard wall behind them',
    evidence: [
      {
        label: 'Stealth controls',
        title: 'Safety settings are part of the product surface.',
        body: 'The app includes decoy PIN setup, quick-exit behaviour, app masking concepts, and reminders about visible Android recording indicators.',
      },
      {
        label: 'Data controls',
        title: 'Retention is a choice with risk language.',
        body: 'Privacy screens keep reports on the phone until you delete them, and offer export, restore, backup, and two-step delete flows. Automatic deletion after 30 or 90 days is planned but switched off until legal approval.',
      },
      {
        label: 'Support boundaries',
        title: 'The app informs without pretending to be emergency care.',
        body: 'Survivor-facing copy keeps medical, legal, police, counselling, and emergency-service boundaries explicit.',
      },
    ],
    stats: [
      { value: 'Local', label: 'draft-first data handling' },
      { value: 'Choice', label: 'keep on the phone or delete when you decide' },
      { value: 'Decoy', label: 'calculator mode and quick-exit support' },
    ],
    cards: [
      {
        title: 'Safety controls',
        body: 'The app includes stealth trigger setup, calculator decoy PIN, quick-exit gesture, app masking, and reminders that Android may show a mic indicator while recording.',
      },
      {
        title: 'Evidence controls',
        body: 'Draft media can track photo, audio, video, or document files with descriptions, annotations, transcripts, metadata, checksums, and privacy settings.',
      },
      {
        title: 'Data controls',
        body: 'Privacy screens keep reports on the phone until the rider deletes them, with local encrypted backup, export, restore, and a deliberate two-step delete flow. Automatic 30/90-day deletion remains off pending legal approval.',
      },
    ],
    stepsTitle: 'What SafeRide does not claim',
    steps: [
      'It does not say a survivor must report to be believed or supported.',
      'It does not claim to replace emergency care, police response, lawyers, clinics, or counsellors.',
      'It does not publish survivor stories, exact journeys, evidence, or identity without explicit safeguarding review.',
      'It does not make route-safety claims before field pilots produce measured evidence.',
    ],
    faq: [
      { question: 'Can I delete my report?', answer: 'Yes. Reports stay on the phone until you delete them, and deleting is a deliberate two-step action. Local encrypted backup, export and restore are also there.' },
      { question: 'Will the app delete my report automatically?', answer: 'Not yet. Automatic deletion after 30 or 90 days is planned but switched off until legal approval.' },
      { question: 'Can someone tell I have the app?', answer: 'The app includes a decoy PIN with a calculator mode, a quick-exit gesture and app masking. Android may still show a microphone indicator while audio is recording.' },
      { question: 'Who do I call if I need help now?', answer: 'SafeRide is not an emergency service. Its local tips explain the 1195 helpline, PEP and emergency contraception windows, P3 forms and evidence handling.' },
    ],
    ctaTitle: 'Understand the privacy controls before sharing anything.',
    cta: { label: 'Review privacy and trust', href: '/privacy-safety-trust' },
  },
  'partner-dashboard': {
    updatedAt: '2026-11-06',
    ogImage: '/og/partner-dashboard.jpg',
    evidenceTitle: 'What the partner dashboard is, and what it is not.',
    variant: 'index',
    eyebrow: 'Partner dashboard',
    title: 'Where a shared report reaches the partner, and nowhere else.',
    intro:
      'In the pilot, the partner dashboard was the signed-in workspace where named HURIA staff saw the reports riders chose to share and followed them up. It is not public, and it holds no exact locations.',
    heroTitle: 'One workspace, for the people who follow up.',
    heroBody:
      'A rider decides what leaves her phone. During the pilot, if she shared, named HURIA staff saw it here at the level she chose, updated its status and added notes, and she could follow that status in the app.',
    tone: 'bg-[#F7EC36]',
    accent: 'bg-[#F88539]',
    image: '/images/partner-dashboard-sign-in.webp',
    imageAlt: 'The SafeRide and HURIA partner dashboard sign-in screen, with empty work email and password fields and a Continue button.',
    evidence: [
      {
        label: 'Who sees it',
        title: 'Named staff, with their own accounts.',
        body: 'During the pilot, HURIA staff used individual accounts and passwords, with an authenticator step when their organization required it. Access is set up with each partner directly. There is no public link.',
      },
      {
        label: 'What it shows',
        title: 'Only what the rider chose to share.',
        body: 'For an escalation, the minimised packet at the redaction level she chose. For a support referral, a short brief. Sharing is off unless she turns it on and ticks the consent for that report.',
      },
      {
        label: 'What it leaves out',
        title: 'No exact locations and no evidence files.',
        body: 'Map coordinates are removed before staff see a packet. Staff see the list of evidence with the rider’s descriptions and transcripts, not the photos, audio, video or documents themselves.',
      },
    ],
    stats: [
      { value: 'Signed-in', label: 'staff accounts only' },
      { value: 'Six areas', label: 'broad Mombasa subcounties' },
      { value: 'No exact', label: 'locations in the dashboard' },
    ],
    cards: [
      {
        title: 'Follow-up in one place',
        body: 'During the pilot, HURIA staff updated the status of a report and added notes. The notes and status are stored on SafeRide’s server, and the rider could follow the status in the app.',
      },
      {
        title: 'Broad coverage by area',
        body: 'Shared cases are grouped by six Mombasa subcounties, using only already-scrubbed broad location text. Missing, withheld, multiple or legacy locations stay unmapped. The map is not a route score.',
      },
      {
        title: 'Every opening was recorded',
        body: 'During the pilot, each time staff opened a report or a callback number, SafeRide recorded who did it and when. Those records held no report content and no IP address.',
      },
    ],
    stepsTitle: 'How a shared report moves',
    steps: [
      'A rider chooses to share, ticks the consent for that report, and picks the redaction level.',
      'SafeRide routes the report to the partner only while its recorded agreement is current and intake is enabled.',
      'Named staff open it in the dashboard, and the opening is recorded.',
      'Staff update the status and add notes. The rider follows the status in the app and can call the partner with her reference number.',
    ],
    faq: [
      { question: 'Can anyone open the partner dashboard?', answer: 'No. It is for named staff at a partner organization. Each person has an individual account, and access is set up with the partner directly rather than published on this site.' },
      { question: 'What can partner staff see?', answer: 'Only what the rider chose to share: a minimised escalation packet at her chosen redaction level, or a short support brief. They do not see her exact location, her evidence files, or the email address or phone number of her SafeRide account.' },
      { question: 'Does the dashboard rank routes or operators?', answer: 'No. It groups shared cases by broad Mombasa subcounty for follow-up. Case counts do not measure route safety, operator performance or individual risk, and no public route score exists.' },
      { question: 'Who else works with the dashboard?', answer: 'In the pilot HURIA is the only partner the app offers. Other organizations are not connected.' },
    ],
    ctaTitle: 'Want to work with SafeRide as a partner?',
    cta: { label: 'Talk to us about partnering', href: '/partners' },
  },
  'open-source': {
    updatedAt: '2026-11-01',
    ogImage: '/og/open-source.jpg',
    evidenceTitle: 'What reviewers can inspect publicly.',
    variant: 'editorial',
    eyebrow: 'Source and model transparency',
    title: 'An auditable open-source snapshot with explicit boundaries.',
    intro:
      'SafeRide publishes a reviewed public snapshot of its mobile app, website, owned API, local infrastructure, public-safe AI tooling, tests, and release evidence under approved open licenses without exposing restricted people or operational records.',
    heroTitle: 'Public-interest technology needs public accountability.',
    heroBody:
      'The public snapshot includes the Android client, owned API, local infrastructure, website, on-device assistant configuration, release checksums, model cards, and clear statements about what is tested, restricted, or still pending.',
    tone: 'bg-[#F88539]',
    accent: 'bg-[#50C9F0]',
    image: '/images/open-source-review-desk.webp',
    imageAlt: 'SafeRide source-review desk with repository, Android device, and architecture notes',
    evidence: [
      {
        label: 'Client',
        title: 'The Android client shows the product contract.',
        body: 'Screens, navigation, draft persistence, case tracking, privacy controls, and content packs can be reviewed directly in the repository.',
      },
      {
        label: 'Backend',
        title: 'The owned API and local infrastructure are reviewable.',
        body: 'The public repository is a sanitised snapshot from August 2026 (v0.5.8). It shows the first-party API, Postgres migrations and privacy controls as they were then. The current app and server, including the HURIA pilot code, live in a private repository and have not been republished.',
      },
      {
        label: 'Assistant',
        title: 'The tested local model path is hash-bound.',
        body: `The ${MODEL_VERSION} LiteRT-LM model, immutable revision, byte size, checksum, runtime, and Android testing limits are published without claiming production or survivor-facing approval.`,
      },
      {
        label: 'Launch site',
        title: 'The website is part of the audit surface.',
        body: 'Routes, metadata, sitemap, robots policy, contact inbox, and public copy are treated as launch artifacts that reviewers can test, not marketing afterthoughts.',
      },
    ],
    resources: [
      {
        label: 'Source',
        title: 'Canonical GitHub repository',
        body: 'Review the Apache-2.0 v0.5.8 snapshot of the mobile app, website, owned API, local infrastructure, public AI tooling, and release evidence. It does not yet include Android 1.0.x.',
        href: 'https://github.com/esherialabs/saferide',
      },
      {
        label: 'Model',
        title: 'Gemma 4 mobile model card',
        body: `Inspect the exact ${MODEL_VERSION} LiteRT-LM artifact, checksum, Android observation, evaluation boundaries, and required device-matrix caveats.`,
        href: 'https://huggingface.co/esherialabs/saferide-gemma-4-e2b-v058-original-419806-litertlm',
      },
      {
        label: 'Install',
        title: 'Android pilot download',
        body: 'Use the pilot carefully, with the safety boundaries and APK handling notes made explicit.',
        href: '/download',
      },
      {
        label: 'Safety',
        title: 'Privacy and trust model',
        body: 'Read the local-first, consent-gate, redaction, retention, deletion, and backend ownership commitments.',
        href: '/privacy-safety-trust',
      },
      {
        label: 'Public guides',
        title: 'Safety and legal notes',
        body: 'Share public-facing explanations of privacy, referral boundaries, and route-safety data with reviewers.',
        href: '/blog',
      },
      {
        label: 'Contact',
        title: 'Review inbox',
        body: 'Send security, safeguarding, legal-content, API, or pilot-review questions to the SafeRide team.',
        href: '/contact',
      },
    ],
    stats: [
      { value: 'Snapshot', label: 'public source is v0.5.8 (Aug 2026), not the current build' },
      { value: 'Separate', label: 'code, content, model, and dataset terms' },
      { value: MODEL_VERSION, label: 'hash-bound LiteRT-LM testing artifact' },
    ],
    cards: [
      {
        title: 'Android client',
        body: 'Expo and React Native power the app screens, navigation, offline draft storage, privacy controls, decoy mode, quick exit, and case workflows.',
      },
      {
        title: 'Local assistant',
        body: `The Gemma 4 E2B registry binds the exact ${MODEL_VERSION} LiteRT-LM file, immutable URL, checksum, storage lifecycle, survivor-centred prompt, and fail-closed capability controls.`,
      },
      {
        title: 'Backend transition',
        body: 'The pilot used SafeRide’s own first-party API and Postgres/object-storage stack. The public snapshot does not include the current build.',
      },
      {
        title: 'Launch transparency',
        body: 'The website publishes canonical release metadata, APK checksum, model links, source-mirror provenance, safety boundaries, sitemap coverage, and contact paths.',
      },
    ],
    stepsTitle: 'What contributors can audit now',
    steps: [
      'Review privacy claims against draft storage, consent screens, data export, decoy PIN, and quick-exit utilities.',
      'Review the first-party API and local-infrastructure migration while preserving local-first behaviour.',
      'Verify the Android preview and on-device model against the published hashes and stated device limits.',
      'Validate legal and support content with Kenyan GBV, medical, legal, and safeguarding experts.',
    ],
    faq: [
      { question: 'Is the public repository the current build?', answer: 'No. The Apache-2.0 repository is a sanitised August 2026 snapshot. The current pilot build, partner dashboard and HURIA workflow live in a private repository and have not been republished.' },
      { question: 'Does the assistant run on the phone?', answer: 'The Android testing preview is built to run the tuned assistant locally for text guidance. It is a controlled testing build: transcription, tagging, production use and lower-memory devices are still gated.' },
      { question: 'Where can I read the code?', answer: 'The public source links on this page point to the canonical open-source repository.' },
    ],
    ctaTitle: 'Review the public source, model, and release evidence.',
    cta: { label: 'Read the pilot update', href: '/impact' },
  },
  partners: {
    updatedAt: '2026-11-01',
    ogImage: '/og/partners.jpg',
    evidenceTitle: 'Where partners make the difference.',
    variant: 'editorial',
    eyebrow: 'Partners',
    title: 'Partner with us: GBV organizations, matatu operators, funders.',
    intro:
      'SafeRide ran a supervised HURIA pilot in Mombasa. The next phase needs safeguarding, privacy, legal, transport, infrastructure, and evaluation partners who can help the work learn safely.',
    heroTitle: 'A pilot, built through operational partnership.',
    heroBody:
      'HURIA is the partner. The wider partner work is to test language, referral boundaries, route data methods, escalation workflows, and first-party API design without asking survivors to carry platform risk.',
    tone: 'bg-[#53E17C]',
    accent: 'bg-[#F88539]',
    image: '/images/huria-community.webp',
    imageAlt: 'A large group of partners and community members seated and standing together, many of them waving, in a hall hung with colourful fabric.',
    pilotStrip: {
      eyebrow: 'Working with HURIA',
      title: 'A partner in the room.',
      intro:
        'HURIA is the partner. This photograph shows the partner team and the SafeRide team together after the briefing in Mombasa.',
      photos: [PILOT_PHOTOS.teamSmiling],
    },
    evidence: [
      {
        label: 'Mombasa pilot',
        title: 'HURIA is the partner.',
        body: `HURIA is the partner in SafeRide's supervised pilot, which ran in October 2026 in ${PILOT.region}.`,
      },
      {
        label: 'Support orgs',
        title: 'Referral language needs expert review.',
        body: 'Crisis copy, 1195 guidance, PEP/EC content, P3 explanations, and referral briefs should be reviewed by qualified Kenyan support and legal-aid partners.',
      },
      {
        label: 'Transport',
        title: 'Operators need action routines, not dashboards alone.',
        body: 'Redacted route signals should connect to route changes, training, escalation handling, and follow-up accountability.',
      },
      {
        label: 'Engineering',
        title: 'Backend hardening is safeguarding work.',
        body: 'Authentication, retention, encrypted evidence handling, access controls, moderation, and observability need partner-level scrutiny before scale.',
      },
    ],
    partners: [
      {
        name: 'UNICEF Venture Fund',
        role: 'FemTech and source-transparency support',
        initials: 'UN',
        href: 'https://www.unicefventurefund.org/company/esheria-ventures',
      },
      {
        name: 'Usikimye',
        role: 'Kenya GBV survivor support',
        initials: 'US',
        logo: '/images/partners/usikimye.png',
        href: 'https://www.usikimye.org/',
      },
      {
        name: 'FIDA Kenya',
        role: 'Women lawyers and legal aid',
        initials: 'FK',
        logo: '/images/partners/fida-kenya.png',
        href: 'https://fidakenya.org/',
      },
      {
        name: 'Human Rights Agenda',
        role: 'Coast rights and legal aid · Toll-free 0769 546 253',
        initials: 'HA',
        logo: '/images/partners/human-rights-agenda.png',
        href: 'https://huria.ngo/',
      },
      {
        name: 'Nairobi West Prison',
        role: 'Kenya justice access deployment site',
        initials: 'NW',
        logo: '/images/partners/nairobi-west-prison.webp',
        href: 'https://esheria.org/stories/when-information-is-freedom-rethinking-justice-from-inside-kenya-s-prisons',
      },
    ],
    press: PRESS_COVERAGE,
    stats: [
      { value: 'Oct 2026', label: 'supervised pilot with HURIA' },
      { value: 'Mombasa', label: 'pilot location' },
      { value: 'Opt-in', label: 'sharing with HURIA was a separate choice' },
    ],
    cards: [
      {
        title: 'Support organizations',
        body: 'Review crisis language, 1195 guidance, PEP/EC content, P3 explanations, referral briefs, and boundaries around legal and psychosocial support.',
      },
      {
        title: 'Transport operators',
        body: 'Validate whether redacted route signals, escalation packets, and follow-up timelines can create safer operational routines.',
      },
      {
        title: 'Engineering partners',
        body: 'Review the owned SafeRide API: authentication, retention, evidence handling, observability, and access controls.',
      },
    ],
    stepsTitle: 'Partnership criteria',
    steps: [
      'No partner receives raw survivor evidence or exact journeys without explicit user choice and safeguarding approval.',
      'Every pilot must define referral escalation boundaries, data retention, deletion, and incident response before launch.',
      'Transport partners must commit to action loops, not just dashboards.',
      'Technical partners must preserve offline-first behaviour while reducing backend and secret-management risk.',
    ],
    faq: [
      { question: 'Who is the pilot partner?', answer: `HURIA is the partner in SafeRide’s supervised pilot, which ran in October 2026 in ${PILOT.region}.` },
      { question: 'Where did the pilot run?', answer: `In ${PILOT.areas}, ${PILOT.region}.` },
      { question: 'How can an organisation work with SafeRide?', answer: 'Write to the SafeRide team through the contact page.' },
    ],
    ctaTitle: 'Help the pilot learn safely.',
    cta: { label: 'Start a partner inquiry', href: '/contact' },
  },
  story: {
    updatedAt: '2026-11-02',
    ogImage: '/og/story.jpg',
    evidenceTitle: 'The evidence behind the story.',
    variant: 'manifesto',
    eyebrow: 'Our story',
    title: 'Built in Nairobi, piloted with HURIA in Mombasa.',
    intro:
      'Esheria built SafeRide for public transport harassment, private evidence handling, Kenyan legal and support guidance, and route-level accountability. The work ran as a supervised pilot in Mombasa in October 2026.',
    heroTitle: 'From preparation to a Coast pilot.',
    heroBody:
      'The work is practical: make it easier to record facts, understand rights, find support, preserve agency, and create prevention signals without turning survivor experiences into marketing material. That work ran in October 2026 as a supervised HURIA pilot in Mombasa.',
    tone: 'bg-[#F88539]',
    accent: 'bg-[#F7EC36]',
    image: '/images/route-safety-bus.webp',
    imageAlt: 'People gather around a route-safety board at a Nairobi matatu stage, beside a SafeRide-branded matatu.',
    evidence: [
      {
        label: 'Origin',
        title: 'The story starts with daily transit risk.',
        body: 'SafeRide focuses on public transport harassment, evidence control, and practical support pathways for Nairobi riders.',
      },
      {
        label: 'Principle',
        title: 'The product should never mine trauma for growth.',
        body: 'Public claims, visuals, and metrics need to stay traceable to product behaviour or pilot evidence, not dramatic survivor storytelling.',
      },
      {
        label: 'Mombasa pilot',
        title: 'The partnership moved from preparation to delivery.',
        body: `HURIA is the partner in SafeRide's supervised pilot, which ran in October 2026 in ${PILOT.region}.`,
      },
      {
        label: 'Review',
        title: 'Open work invites challenge before scale.',
        body: 'The website, roadmap, content packs, mobile flows, pilot records, and UNICEF Venture Fund presentation are presented as reviewable artifacts rather than a finished institutional promise.',
      },
    ],
    presentationImages: [
      {
        src: '/images/pictures/UNI986641.webp',
        alt: 'SafeRide CEO speaking with attendees during a UNICEF Venture Fund presentation',
        caption: 'Founder presentation and reviewer discussion during the UNICEF Venture Fund meet.',
      },
    ],
    media: SPICE_FM_CLIP,
    stats: [
      { value: 'Mombasa', label: 'supervised pilot location' },
      { value: 'HURIA', label: 'named Coast partner' },
      { value: 'Ran', label: 'pilot status' },
    ],
    cards: [
      {
        title: 'Built for the first minutes',
        body: 'The app creates a draft and gives structured prompts before a user has to decide whether to report, refer, map, or escalate.',
      },
      {
        title: 'Built for discretion',
        body: 'Stealth trigger setup, calculator decoy mode, quick exit, app masking, and local retention choices reflect real-world safety constraints.',
      },
      {
        title: 'Built for accountability',
        body: 'Case tracking, public source documentation, and a first-party API keep the product focused on measurable safety improvements. Route-level insights remain planned.',
      },
    ],
    stepsTitle: 'What guides the work',
    steps: [
      'Do not sensationalize survivor experience for visual design, metrics, or fundraising.',
      'Make safety, privacy, and route-accountability claims traceable to product behaviour or pilot evidence.',
      'Treat backend ownership, retention, encryption, and observability as safeguarding work.',
      'Keep the public work reviewable so partners can challenge and improve it.',
    ],
    faq: [
      { question: 'Why does SafeRide start a draft on the phone?', answer: 'So a rider can start a private report before the signal returns, and decide later what, if anything, leaves her phone.' },
      { question: 'Who is behind SafeRide?', answer: `SafeRide is developed by ${PARENT_ORG.name}, the public-interest and social-impact initiative at esheria.org.` },
      { question: 'Has SafeRide been tested with a partner?', answer: `Yes. It ran as a supervised pilot with HURIA in ${PILOT.region} in October 2026.` },
    ],
    ctaTitle: 'See how the Mombasa pilot was delivered.',
    cta: { label: 'Read the pilot update', href: '/impact' },
    contextLink: { label: 'Visit Esheria, the organization behind SafeRide', href: PARENT_ORG.url },
  },
  impact: {
    updatedAt: '2026-11-01',
    ogImage: '/og/impact.jpg',
    evidenceTitle: 'What the Mombasa pilot has delivered.',
    variant: 'index',
    eyebrow: 'Impact and transparency',
    title: 'The pilot has run. We are measuring what comes next.',
    intro:
      `SafeRide ran a supervised pilot with ${PILOT.partner} in ${PILOT.region}. We recorded what was delivered, what was tested, and what we do not claim without evidence.`,
    heroTitle: 'From promises to field evidence.',
    heroBody:
      'The pilot tracked whether people could start reports, understand consent, use legal and support content, preserve evidence, and complete a safe handoff. It does not publish survivor narratives, exact journeys, or route scores.',
    tone: 'bg-[#F7EC36]',
    accent: 'bg-[#53E17C]',
    image: PILOT_PHOTOS.demoLively.src,
    imageAlt: PILOT_PHOTOS.demoLively.alt,
    imagePosition: 'object-[30%_40%]',
    pilotStrip: {
      eyebrow: 'What it looked like',
      title: 'Questions, answered on the spot.',
      intro:
        'The overview above is deliberately broad. This photograph shows what the pilot looked like on the ground: a live demo, with the team taking questions there and then.',
      photos: [PILOT_PHOTOS.liveDemoClap],
    },
    evidence: [
      {
        label: 'Delivered',
        title: 'The partnership moved into delivery.',
        body: 'HURIA is the partner in SafeRide’s supervised pilot, which ran in October 2026 in Mombasa.',
      },
      {
        label: 'Tested',
        title: 'The controlled pilot tested the real workflow.',
        body: 'The pilot tested survivor-controlled reporting and a safe, consented handoff. Sharing with HURIA remained a separate, opt-in choice.',
      },
      {
        label: 'Measured',
        title: 'We measure behaviour before outcomes.',
        body: 'Completion, consent comprehension, support usefulness, reproducible problems, and partner follow-up matter more than broad claims about safety outcomes.',
      },
    ],
    stats: [
      { value: 'Ran', label: 'supervised pilot in Mombasa' },
      { value: 'HURIA', label: 'pilot partner' },
      { value: 'Opt-in', label: 'sharing was a separate choice' },
    ],
    cards: [
      {
        title: 'Product evidence',
        body: 'We recorded whether the draft, evidence, legal framing, pathway, consent, and case tracker screens were usable under low-signal and high-stress conditions.',
      },
      {
        title: 'Safeguarding evidence',
        body: 'We reviewed whether tips, provider choices, referral briefs, and AI guidance avoided overpromising and pointed users toward qualified human support.',
      },
      {
        title: 'Infrastructure evidence',
        body: 'The pilot ran on SafeRide’s own API, Postgres, and object storage. We recorded what changed without treating availability as field validation.',
      },
    ],
    stepsTitle: 'What we publish, and what we do not',
    steps: [
      'We separated what was delivered from what remained under test.',
      'We report unresolved risks around consent, evidence handling, access, and support coverage.',
      'We do not publish survivor stories, exact journeys, raw evidence, or identifying pilot details.',
      'We publish non-sensitive pilot learnings, methodology limits, and corrective actions after review.',
    ],
    faq: [
      { question: 'What did the pilot test?', answer: `Whether people could start reports, understand consent, use legal and support content, preserve evidence and complete a safe handoff, in a supervised pilot with HURIA in ${PILOT.region}.` },
      { question: 'Where did it run?', answer: `In ${PILOT.areas}. ${PILOT.continuity}` },
      { question: 'Are survivor stories or journeys published?', answer: 'No. The overview is deliberately broad: it names the pilot areas, not the people, journeys or reports behind them, and it publishes no route scores.' },
    ],
    ctaTitle: 'Review the pilot facts and the safety boundary.',
    cta: { label: 'Read the privacy model', href: '/privacy-safety-trust' },
  },
  'privacy-safety-trust': {
    updatedAt: '2026-11-01',
    ogImage: '/og/privacy-safety-trust.jpg',
    evidenceTitle: 'How privacy is enforced in the product.',
    variant: 'playbook',
    eyebrow: 'Privacy, safety, and trust',
    title: 'Your report stays private until you decide otherwise.',
    intro:
      'The Mombasa pilot kept drafts local, asked for consent before sharing, and gave riders retention, export, and delete choices. Automatic deletion is still off pending legal approval.',
    heroTitle: 'Local first. Shared by choice.',
    heroBody:
      'Before referral or escalation, the app summarizes what leaves the device and what stays private. Route mapping remains a planned layer.',
    tone: 'bg-[#53E17C]',
    accent: 'bg-[#50C9F0]',
    image: '/images/legal-aid-guidance.webp',
    imagePosition: 'object-[22%_55%]',
    imageAlt: 'Illustration of a support worker laying out cards for referral options, evidence safety and the 1195 helpline.',
    pilotStrip: {
      eyebrow: 'From the pilot',
      title: 'The rule on the wall.',
      intro:
        'The privacy principle was part of the partner briefing: the rider decides what leaves her phone.',
      photos: [PILOT_PHOTOS.privacySlide],
    },
    evidence: [
      {
        label: 'Consent',
        title: 'The consent gate is the privacy contract.',
        body: 'The app is structured so referral and escalation paths require a review step before data leaves the device. Route mapping remains a planned layer.',
      },
      {
        label: 'Retention',
        title: 'Longer storage is treated as higher risk.',
        body: 'Retention choices, backup, export, and deletion copy explain control without hiding the safety tradeoffs.',
      },
      {
        label: 'Infrastructure',
        title: 'Backend restraint is part of user trust.',
        body: 'The pilot ran on SafeRide’s own API, Postgres, and object storage. The public source snapshot is separate from the current pilot build.',
      },
    ],
    stats: [
      { value: 'Consent', label: 'before referral or escalation' },
      { value: 'Redact', label: 'none, light, or heavy escalation options' },
      { value: 'Owned', label: 'SafeRide first-party pilot services' },
    ],
    cards: [
      {
        title: 'Sensitive drafts',
        body: 'Drafts can include media, transcripts, checksums, legal tags, location accuracy, and pathway choices, so the product must keep review and deletion controls prominent.',
      },
      {
        title: 'Referral boundaries',
        body: 'The app can route a sanitized brief to hotline, GBV centre, legal aid, counselling, or fallback number flows, but it must not impersonate these services.',
      },
      {
        title: 'Backend ownership',
        body: 'SafeRide’s own API, Postgres, and object storage carried the pilot workflow. Authentication, retention, evidence handling, and access controls remain active review areas.',
      },
    ],
    stepsTitle: 'Pilot safeguards',
    steps: [
      'We review all public claims for safety, privacy, medical, legal, and emergency-service overpromising.',
      'We kept automatic deletion, backup, analytics, and evidence-sharing choices under review during the pilot.',
      'We used SafeRide’s first-party API and object storage for the pilot workflow and recorded the boundaries.',
      'We do not publish survivor stories, exact route details, or evidence screenshots without explicit safeguarding review.',
    ],
    faq: [
      { question: 'What does redaction do?', answer: 'Before an escalation packet is shared you can choose none, light or heavy redaction, and review exactly what will be sent.' },
      { question: 'Whose servers carried the pilot?', answer: 'SafeRide’s own API, Postgres and object storage carried the pilot workflow. Authentication, retention, evidence handling and access controls remain active review areas.' },
      { question: 'Can the app pretend to be a support service?', answer: 'No. It can prepare a sanitised brief for a hotline, GBV centre, legal aid, counselling or fallback number, but it must not impersonate any of them.' },
    ],
    feature: {
      eyebrow: 'In the app',
      title: 'You choose what the app can use.',
      paragraphs: [
        'The first screen asks for permissions and says plainly that you can continue without granting everything. Nothing is switched on for you.',
      ],
      points: [
        'Location is added only when you choose to use device location.',
        'The microphone records only when you use a supported SafeRide capture action.',
        'You can skip for now and change either choice later in Settings.',
      ],
      image: '/images/privacy-controls-product.webp',
      imageAlt: 'SafeRide Android permission screen with Ask location and Ask microphone choices, a Request Permissions button and a Skip for Now button, beside a settings list',
      imageWidth: 1024,
      imageHeight: 768,
    },
    ctaTitle: 'Review what stays private and what can be shared.',
    cta: { label: 'Read how it works', href: '/how-it-works' },
  },
} as const;
