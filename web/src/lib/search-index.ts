export type SearchItem = {
  title: string;
  href: string;
  excerpt: string;
  keywords: string;
  priorityTerms?: readonly string[];
};

export const SEARCH_ITEMS: readonly SearchItem[] = [
  {
    title: 'Home',
    href: '/',
    excerpt: 'SafeRide is an Android-first, offline-capable safety companion which ran a supervised pilot with HURIA in Mombasa in October 2026.',
    keywords: 'saferide safer journeys women nairobi mombasa huria pilot public transport report evidence consent routes accountability android offline',
  },
  {
    title: 'Mombasa pilot',
    href: '/impact',
    excerpt: 'The HURIA pilot ran in October 2026 in Mombasa. See the overview and the boundaries.',
    keywords: 'mombasa huria pilot october 2026 supervised overview',
  },
  {
    title: 'The Pilot in Pictures',
    href: '/pilot',
    excerpt: 'Real photographs from the supervised HURIA pilot in Mombasa: the partner briefing, live demo, hands-on sessions and a community day.',
    keywords: 'pilot photos pictures photographs gallery mombasa huria briefing live demo community day team october 2026',
  },
  {
    title: 'What We Do',
    href: '/what-we-do',
    excerpt: 'SafeRide ran a supervised HURIA pilot in Mombasa while keeping reporting survivor-controlled.',
    keywords: 'what we do controlled reporting workflow survivors communities evidence route accountability legal framing pathway selection case tracking mombasa huria pilot',
  },
  {
    title: 'How It Works',
    href: '/how-it-works',
    excerpt: 'Capture first, consent before sharing. The workflow was tested in the Mombasa pilot.',
    keywords: 'how it works capture consent sharing draft evidence legal framing pathway referral escalation redaction retention mombasa huria pilot',
  },
  {
    title: 'For Survivors',
    href: '/for-survivors',
    excerpt: 'SafeRide protects choice, privacy, and pace in the Mombasa pilot.',
    keywords: 'survivors privacy choice pace no forced report no hidden upload support pathway local draft delete export retention',
  },
  {
    title: 'Privacy, Safety, and Trust',
    href: '/privacy-safety-trust',
    excerpt: 'Review consent, retention, redaction, deletion, backup, and the pilot backend.',
    keywords: 'privacy safety trust consent retention redaction delete deletion backup export local first backend migration first party api mombasa pilot',
    priorityTerms: ['privacy', 'safety', 'trust', 'consent', 'retention', 'redaction', 'delete', 'deletion', 'backup', 'export'],
  },
  {
    title: 'Partner Dashboard',
    href: '/partner-dashboard',
    excerpt: 'Where a rider’s shared report reaches named partner staff: signed-in, broad areas only, no exact locations.',
    keywords: 'partner dashboard huria staff follow-up shared report case status notes subcounty mombasa access consent redaction',
  },
  {
    title: 'Source & Models',
    href: '/open-source',
    excerpt: 'The repo is the evidence reviewers can inspect.',
    keywords: 'open source github model card gemma api roadmap android repository audit',
  },
  {
    title: 'Partners',
    href: '/partners',
    excerpt: 'HURIA is the partner in SafeRide’s Mombasa pilot.',
    keywords: 'partners pilot mombasa huria changamwe likoni sacco support organizations funders regulators safeguarding legal review fida usikimye unicef press spice fm video clip pink perspective',
  },
  {
    title: 'Our Story',
    href: '/story',
    excerpt: 'SafeRide grew from everyday transport risk into a supervised HURIA pilot in Mombasa.',
    keywords: 'story origin nairobi mombasa huria pilot local first survivor controlled transport risk unicef venture fund',
  },
  {
    title: 'Impact',
    href: '/impact',
    excerpt: 'See what the Mombasa pilot delivered, what it tested, and what it does not claim.',
    keywords: 'impact transparency metrics pilot mombasa huria usability safeguarding completion trust route action field evidence',
  },
  {
    title: 'Guides',
    href: '/blog',
    excerpt: 'Public SafeRide guides on privacy, survivor choice, support pathways, and route safety.',
    keywords: 'guides blog privacy legal support route consent public press field note',
  },
  {
    title: 'How SafeRide keeps a report private until you choose a path',
    href: '/blog/private-reporting-control',
    excerpt: 'Start with a local draft, review what is recorded, and decide what leaves the phone.',
    keywords: 'private reporting control report privacy local draft consent choose path referral anonymous map escalation',
  },
  {
    title: 'Medical, legal, and support steps riders can understand before they report',
    href: '/blog/kenya-support-pathways',
    excerpt: 'Understand support choices in plain language without pressure.',
    keywords: 'kenya support pathways medical legal pep emergency contraception p3 1195 helpline gbv care',
  },
  {
    title: 'How anonymous route signals can improve transport safety without exposing survivors',
    href: '/blog/route-safety-without-exposure',
    excerpt: 'Route accountability should use minimized, aggregated, consented signals.',
    keywords: 'route safety exposure anonymous signals aggregate survivor identity private evidence exact journeys safeguards',
  },
  {
    title: 'Download App',
    href: '/download',
    excerpt: 'Install the SafeRide Android pilot carefully.',
    keywords: 'download app apk android pilot install checklist unknown apps onboarding permissions stealth quick exit checksum signature',
  },
  {
    title: 'Contact',
    href: '/contact',
    excerpt: 'Contact SafeRide about pilot partnerships, safeguarding review, and source or model review.',
    keywords: 'contact saferide pilot partnership safeguarding privacy review open source github funder support organization sacco operator regulator email',
  },
] as const;
