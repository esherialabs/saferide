import { GUIDES } from '@/content/guides';
import { ANDROID_RELEASE } from '@/lib/android-release';
import { PILOT_PHOTOS } from '@/lib/pilotPhotos';

export const PRODUCTION_ORIGIN = 'https://saferide.esheria.org';

// SafeRide is an Esheria Foundation initiative. It is intentionally separate
// from the commercial esheria.ai product site.
export const PARENT_ORG = {
  name: 'Esheria Foundation',
  schemaId: 'https://esheria.org/#organization',
  url: 'https://esheria.org/',
} as const;

export const BRAND_NAME = 'SafeRide by Esheria Foundation';

// One source for how the public site names the pilot (past tense: it ran in October 2026; do not say live or now). Do not describe it
// elsewhere as a Nairobi or route-safety pilot.
export const PILOT = {
  name: 'HURIA pilot',
  partner: 'Human Rights Agenda (HURIA)',
  region: 'Mombasa',
  areas: 'Changamwe and Likoni',
  summary: 'supervised HURIA pilot in Mombasa',
  status: 'ran',
  startedAt: 'October 2026',
  description:
    'SafeRide ran a supervised pilot with HURIA in Mombasa in October 2026.',
  approach:
    'The pilot ran in two stages: practice first, then live reporting with HURIA present. People worked through fictional scenarios, then used their own phones to write a private report and choose whether to share it.',
  partnerPath:
    'During the pilot, reports that people chose to share reached HURIA in its own partner dashboard as they were sent, so the whole path from phone to follow-up could be watched in real use.',
  feedback:
    'Feedback came from the sessions themselves: facilitator notes, direct observation, and issues raised while the app was in use. Problems that surfaced were fixed and reviewed, and the findings shaped the next round of work.',
  continuity:
    'Evaluation of the pilot with HURIA in Changamwe and Likoni continues.',
  privacy:
    'This overview is deliberately broad: it names the pilot areas, not the people, journeys, or reports behind them.',
} as const;

// The on-device model is versioned separately from the app (for example
// "...-v058-..." is v0.5.8). Derived from the release record so it cannot drift.
const modelVersionMatch = /-v(\d)(\d)(\d)-/.exec(ANDROID_RELEASE.model.modelId);
export const MODEL_VERSION = modelVersionMatch ? `v${modelVersionMatch.slice(1).join('.')}` : 'unversioned';

const configuredSiteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? PRODUCTION_ORIGIN).replace(/\/+$/, '');

export const SITE = {
  name: 'SafeRide',
  operatorLegalName: 'Esheria Ventures Limited',
  tagline: 'Safer journeys for every woman.',
  description:
    'An offline-capable Android safety companion for women to document harassment, find Kenyan support, and choose what leaves the phone. Piloted with HURIA in Mombasa.',
  url: configuredSiteUrl,
  github: process.env.NEXT_PUBLIC_GITHUB_URL ?? 'https://github.com/esherialabs/saferide',
  huggingface:
    process.env.NEXT_PUBLIC_HUGGINGFACE_URL ??
    ANDROID_RELEASE.model.huggingFaceUrl,
  apkUrl:
    process.env.NEXT_PUBLIC_APK_URL ??
    ANDROID_RELEASE.artifact.downloadUrl,
  contactEmail: 'saferide@esheria.org',
  cta: {
    primary: { label: 'Download APK', href: '/download' },
    secondary: { label: 'Get Involved', href: '/contact' },
    nav: { label: 'Download App', href: '/download' },
    donate: { label: 'Support the Pilot', href: '/contact' },
  },
  nav: {
    primaryCta: { label: 'Download', href: '/download' },
    links: [
      {
        label: 'What We Do',
        href: '/what-we-do',
        children: [
          { label: 'How It Works', href: '/how-it-works' },
          { label: 'For Survivors', href: '/for-survivors' },
          { label: 'Privacy & Trust', href: '/privacy-safety-trust' },
          { label: 'Partner Dashboard', href: '/partner-dashboard' },
          { label: 'Impact', href: '/impact' },
        ],
      },
      { label: 'Source & Models', href: '/open-source' },
      { label: 'Our Story', href: '/story' },
      { label: 'Partners', href: '/partners' },
      { label: 'Blog', href: '/blog' },
    ],
  },
  kinetic: ['pilot ran in Mombasa', 'drafts local', 'consent explicit'],
  heroAccordion: [
    {
      eyebrow: 'For survivors',
      label: 'Report safely',
      headline: 'Start a private report before the signal returns.',
      body:
        'The mobile app creates a private draft first, then helps a rider review evidence, location, support, and consent choices without forcing an upload.',
      cta: { label: 'How it works', href: '/how-it-works' },
      tone: 'bg-[#F06C13]',
      imageTone: 'from-[#ffd166] via-[#ff9e5f] to-[#f06c13]',
      motif: 'audio waveform',
      image: '/images/matatu-interior.webp',
      imageSrcSet: '/images/matatu-interior-640.webp 640w, /images/matatu-interior-768.webp 768w, /images/matatu-interior-960.webp 960w, /images/matatu-interior.webp 1248w',
      imageWidth: 1248,
      imageHeight: 848,
      imageAlt: 'Women students riding inside a Nairobi matatu with faces anonymized',
    },
    {
      eyebrow: 'For communities',
      label: 'Out in the community',
      headline: 'Tried in the community, one person at a time.',
      body:
        'At a community day in Mombasa, the team showed the app in person, alongside HURIA, the pilot partner. What came up in those conversations shaped the next round of work.',
      cta: { label: 'See the pilot in pictures', href: '/pilot' },
      tone: 'bg-[#EE9D00]',
      imageTone: 'from-[#53e17c] via-[#50c9f0] to-[#118ab2]',
      motif: 'pilot tags',
      image: PILOT_PHOTOS.communityPanel.src,
      imageSrcSet: `${PILOT_PHOTOS.communityPanel.src} ${PILOT_PHOTOS.communityPanel.width}w`,
      imageWidth: PILOT_PHOTOS.communityPanel.width,
      imageHeight: PILOT_PHOTOS.communityPanel.height,
      imageAlt: PILOT_PHOTOS.communityPanel.alt,
    },
    {
      eyebrow: 'Source transparency',
      label: 'Review the stack',
      headline: 'Safety technology reviewers can inspect.',
      body:
        'The Apache-2.0 public repository is a sanitised August 2026 snapshot. The current pilot build, partner dashboard, and HURIA workflow live in a private repository and have not been republished.',
      cta: { label: 'View the stack', href: '/open-source' },
      tone: 'bg-[#EED800]',
      imageTone: 'from-[#f7ec36] via-[#06d6a0] to-[#1b4332]',
      motif: 'open code',
      image: '/images/app-and-brand.webp',
      imageSrcSet: '/images/app-and-brand-640.webp 640w, /images/app-and-brand-768.webp 768w, /images/app-and-brand-960.webp 960w, /images/app-and-brand.webp 1024w',
      imageWidth: 1024,
      imageHeight: 768,
      imageAlt: 'SafeRide Android home, report, and support screens from the current app',
    },
  ],
  pillars: [
    {
      title: 'A Mombasa pilot, with survivor control at the centre',
      action: 'See the pilot',
      href: '/impact',
      tone: 'bg-[#50C9F0]',
      radius: 'rounded-t-[2rem]',
    },
    {
      title: 'Offline tips, legal tags, and referral choices',
      action: 'How it works',
      href: '/how-it-works',
      tone: 'bg-[#53E17C]',
      radius: 'rounded-bl-[2rem]',
    },
    {
      title: 'A partner dashboard for named follow-up staff',
      action: 'See the dashboard',
      href: '/partner-dashboard',
      tone: 'bg-[#F7EC36]',
      radius: 'rounded-tr-[2rem]',
    },
  ],
  impact: [
    { value: 0, suffix: '', label: 'forced uploads before a rider chooses a pathway' },
    { value: 3, suffix: '', label: 'pilot choices: private, referral, escalation' },
    { value: 3, suffix: '', label: 'redaction modes before an escalation packet is shared' },
  ],
  editorialCards: [
    {
      tag: 'MOMBASA PILOT',
      title: 'SafeRide ran a supervised pilot with HURIA in Mombasa',
      body: 'The work ran in October 2026 as a supervised pilot focused on survivor-controlled reporting and a safe, consented handoff.',
      link: 'See what changed',
      href: '/impact',
      tone: 'bg-[#F88539]',
      side: 'left',
      rounded: '',
      image: '/images/pilot-mombasa-card.svg',
      imageAlt: 'Mombasa, October 2026: a supervised pilot with HURIA.',
    },
    {
      tag: 'PRIVACY-FIRST AI',
      title: 'The Android testing preview is built to run the tuned assistant locally on the phone',
      body: `The Android preview downloads and verifies the ${MODEL_VERSION} LiteRT-LM model for local text guidance. It remains a controlled testing build, with transcription, tagging, production use, and lower-memory device support still gated.`,
      link: 'Read the model plan',
      href: '/open-source',
      tone: 'bg-[#53E17C]',
      side: 'right',
      rounded: 'rounded-tr-[5rem]',
      image: '/images/app-dashboard.webp',
      imageAlt: 'SafeRide Android home dashboard with emergency, report, case tracker, support, and learning actions',
    },
    {
      tag: 'PARTNER DASHBOARD',
      title: 'Shared reports reach named partner staff in a signed-in dashboard',
      body: 'In the pilot, HURIA staff followed up the reports riders chose to share. Staff sign in with their own accounts, the dashboard shows broad Mombasa areas only, never exact locations, and access is set up with each partner directly.',
      link: 'About the partner dashboard',
      href: '/partner-dashboard',
      tone: 'bg-[#50C9F0]',
      side: 'left',
      rounded: '',
      image: '/images/partner-dashboard-sign-in-dark.webp',
      imageAlt: 'The partner dashboard sign-in screen in dark mode, with empty work email and password fields.'
    },
  ],
  community: [
    {
      name: 'Mombasa pilot',
      role: 'Supervised HURIA pilot',
      quote:
        'SafeRide ran a supervised pilot in October 2026 with HURIA in Mombasa, focused on survivor-controlled reporting and a safe, consented handoff.',
      tone: 'from-[#f88539] to-[#f7ec36]',
      image: PILOT_PHOTOS.briefingPointing.src,
      imageAlt: PILOT_PHOTOS.briefingPointing.alt,
    },
    {
      name: 'Mobile App',
      role: 'Private reporting flow',
      quote:
        'SafeRide creates a draft first, tracks completed reporting steps, and only moves to sharing after a pathway and consent review.',
      tone: 'from-[#f88539] to-[#ffd166]',
      image: '/images/survivor-private-draft.webp',
      imageAlt: 'SafeRide Android incident draft screens listing the report steps and a Continue draft button',
    },
    {
      name: 'Legal Content Pack',
      role: 'Rights and support guidance',
      quote:
        'The local tips explain PEP and emergency contraception windows, the 1195 helpline, P3 forms, evidence handling, and referral boundaries.',
      tone: 'from-[#53e17c] to-[#50c9f0]',
      image: '/images/legal-support-options.webp',
      imageAlt: 'SafeRide Android support chat with 1195, provider search, and saved guidance options',
    },
    {
      name: 'Trusted Infrastructure',
      role: 'First-party pilot stack',
      quote:
        'SafeRide’s own API, Postgres, and object storage carried the pilot workflow, with authentication, retention, deletion, and access rules reviewed as safeguarding decisions.',
      tone: 'from-[#f7ec36] to-[#06d6a0]',
      image: PILOT_PHOTOS.briefing.src,
      imageAlt: PILOT_PHOTOS.briefing.alt,
    },
    {
      name: 'Pilot team',
      role: 'Partner and SafeRide teams',
      quote:
        'Feedback came from the sessions themselves: facilitator notes, direct observation, and issues raised while the app was in use. Problems that surfaced were fixed and reviewed.',
      tone: 'from-[#50c9f0] to-[#f7ec36]',
      image: PILOT_PHOTOS.teamFour.src,
      imageAlt: PILOT_PHOTOS.teamFour.alt,
    },
  ],
  updates: GUIDES,
} as const;

export type SitePath = '/' | `/${string}`;

/**
 * Single URL policy for every absolute URL the site emits (canonical, sitemap,
 * Open Graph, JSON-LD): SITE.url origin + path with a trailing slash, matching
 * the static export's `trailingSlash: true` serving form.
 */
export function canonicalUrl(path: SitePath = '/'): string {
  const normalized = path.endsWith('/') ? path : `${path}/`;
  return `${SITE.url}${normalized}`;
}
