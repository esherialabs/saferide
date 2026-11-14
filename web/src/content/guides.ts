export type GuideSection = {
  heading: string;
  paragraphs: readonly string[];
};

export type GuideLink = {
  label: string;
  href: string;
  body: string;
};

export type GuideSource = {
  title: string;
  publisher: string;
  href: string;
};

export type Guide = {
  slug: string;
  ogImage: `/${string}`;
  seoTitle?: string;
  tag: string;
  title: string;
  excerpt: string;
  publishedAt: string;
  updatedAt: string;
  authorName: string;
  reviewStatus: string;
  editorialNote: string;
  sections: readonly GuideSection[];
  actions: readonly GuideLink[];
  sources: readonly GuideSource[];
  relatedSlugs: readonly string[];
};

export const GUIDES = [
  {
    slug: 'private-reporting-control',
    ogImage: '/og/blog-private-reporting-control.jpg',
    tag: 'Privacy first',
    title: 'How SafeRide keeps a report private until you choose a path',
    excerpt:
      'A rider can begin with a local draft, review what is recorded, and decide whether anything leaves the phone.',
    publishedAt: '2026-05-24',
    updatedAt: '2026-11-01',
    authorName: 'SafeRide by Esheria editorial team',
    reviewStatus: 'Safeguarding review required before production publication',
    editorialNote:
      'This guide explains the SafeRide pilot design tested with HURIA in Mombasa in October 2026. It is not emergency, medical, legal, police, or counselling advice.',
    sections: [
      {
        heading: 'Start a private report without waiting for internet access',
        paragraphs: [
          'SafeRide begins with a draft on the rider’s phone. A rider can record what happened in their own words, add only the details they feel safe keeping, and pause without choosing a reporting or support route. The pilot is designed so creating a draft is not the same as sending a report.',
          'That distinction matters on public transport, where signal may be unreliable and someone may be watching the screen. The first task is to preserve the rider’s control, not to force an upload or require an immediate decision. If recording details would create more risk, the rider can leave the draft and return later.',
        ],
      },
      {
        heading: 'Review exactly what would be shared before anything leaves the phone',
        paragraphs: [
          'When a rider is ready, SafeRide presents separate choices: keep the record private, contribute a minimized route signal, prepare information for a support provider, or prepare a more formal report. These choices are not interchangeable, and none should happen silently in the background.',
          'Before sharing, the product should show the information included, the information removed, the destination, and the selected redaction level. The rider should be able to go back, remove an attachment, change the destination, or stop. Consent is useful only when the person can understand and change the decision.',
        ],
      },
      {
        heading: 'Keep personal evidence separate from anonymous route information',
        paragraphs: [
          'A private statement, audio clip, photograph, or support brief can contain details that identify a person. A route-safety signal serves a different purpose: it should describe a broad pattern without carrying names, raw audio, private evidence, or an exact journey.',
          'SafeRide treats those data types as separate records with separate sharing decisions. This reduces the risk that a community-safety feature becomes another way to expose a survivor. It also makes it clearer to transport and civic partners that route trends are not a substitute for consented case information.',
        ],
      },
      {
        heading: 'Use retention and deletion controls as safety features',
        paragraphs: [
          'Privacy is not complete at the moment of collection. A rider also needs a clear way to review, export, retain, or delete a draft. The pilot surfaces those controls so the person can decide whether keeping information on the device remains useful and safe.',
          'Outside the supervised HURIA pilot in Mombasa, anyone testing SafeRide should use synthetic reports until the field configuration, encryption, backup, retention, and support-provider settings have completed safeguarding review. Do not enter real survivor evidence into an unsupervised pilot build.',
        ],
      },
    ],
    actions: [
      {
        label: 'Review the privacy model',
        href: '/privacy-safety-trust',
        body: 'See how local drafts, consent, redaction, retention, and deletion are intended to work together.',
      },
      {
        label: 'Follow the reporting flow',
        href: '/how-it-works',
        body: 'Walk through the steps from a private draft to a rider-controlled next action.',
      },
      {
        label: 'Read the pilot download notes',
        href: '/download',
        body: 'Check the installation and testing boundaries before using the Android build.',
      },
    ],
    sources: [],
    relatedSlugs: ['kenya-support-pathways', 'route-safety-without-exposure'],
  },
  {
    slug: 'kenya-support-pathways',
    ogImage: '/og/blog-kenya-support-pathways.jpg',
    seoTitle: 'Support After Harassment in Kenya',
    tag: 'Know your options',
    title: 'Support after harassment in Kenya: options you can consider at your pace',
    excerpt:
      'SafeRide explains support choices in plain language while keeping clear boundaries: it is not a clinic, lawyer, police desk, or counselling service.',
    publishedAt: '2026-05-24',
    updatedAt: '2026-10-19',
    authorName: 'SafeRide by Esheria editorial team',
    reviewStatus: 'Qualified Kenya support and legal review required before production publication',
    editorialNote:
      'Support information and service availability can change. Confirm time-sensitive medical or legal information with a qualified provider or an official source.',
    sections: [
      {
        heading: 'You can seek support without committing to a formal report',
        paragraphs: [
          'After harassment or violence, people may need different things: immediate safety, medical care, someone to talk to, legal information, help preserving evidence, or time before making another decision. Seeking one kind of support does not mean a person has agreed to every other step.',
          'SafeRide is designed to present choices without implying that someone must report to be believed or to receive help. A rider can keep a private note, ask a support organization what services are available, or prepare questions for a qualified professional before deciding what to share.',
        ],
      },
      {
        heading: 'The national 1195 helpline is one referral starting point in Kenya',
        paragraphs: [
          'Kenya’s State Department for Gender identifies 1195 as a toll-free gender-based violence helpline. The service can receive reports and help connect callers with referral options. A person should use a phone or contact method that feels safe and should avoid sharing more identifying information than is needed to understand the available help.',
          'SafeRide does not operate the helpline and cannot guarantee availability, response time, confidentiality practices, or a particular outcome. If a person faces immediate danger, they should use an appropriate local emergency option or seek help from a trusted person nearby rather than relying on the app.',
        ],
      },
      {
        heading: 'Medical, legal, psychosocial, and community services have different roles',
        paragraphs: [
          'A health provider can explain care and documentation options. A qualified lawyer or legal-aid organization can explain legal choices. A counsellor or survivor-support organization can provide psychosocial and practical support. Police and justice agencies have their own reporting processes. SafeRide should describe these roles without pretending to perform them.',
          'FIDA Kenya and other established women’s-rights organizations publish information about their current services. On the Coast, Human Rights Agenda (HURIA) offers legal aid and human-rights support through its toll-free line, 0769 546 253. Before travelling, sharing evidence, or relying on a deadline, contact the relevant provider or check an official source. Service locations, eligibility, opening hours, and procedures may change.',
        ],
      },
      {
        heading: 'Prepare only the information needed for the support you choose',
        paragraphs: [
          'A useful support brief can be short. It may include the type of help requested, a safe way to respond, and only the incident details needed by the chosen provider. Private notes, raw audio, exact routes, identity documents, or contact details should not be included automatically.',
          'Before sending anything, review the destination and the complete contents. Ask what the provider needs, how the information will be stored, who can see it, and whether it can be deleted. If those answers are unclear, pause and seek clarification before sharing sensitive material.',
        ],
      },
    ],
    actions: [
      {
        label: 'See survivor-controlled choices',
        href: '/for-survivors',
        body: 'Review the boundaries SafeRide uses when presenting support and reporting options.',
      },
      {
        label: 'Understand private drafts',
        href: '/blog/private-reporting-control',
        body: 'Learn how a local draft differs from sending information to another organization.',
      },
      {
        label: 'Contact the SafeRide team',
        href: '/contact',
        body: 'Use the public inbox for partnership or safeguarding review—not for survivor evidence.',
      },
    ],
    sources: [
      {
        title: 'State Department for Gender: 1195 toll-free GBV helpline',
        publisher: 'Government of Kenya',
        href: 'https://gender.go.ke/resources/news/ps-dig-emphasize-need-accountability-fight-against-gender-based-violence',
      },
      {
        title: 'FIDA Kenya services and women’s-rights information',
        publisher: 'FIDA Kenya',
        href: 'https://fidakenya.org/',
      },
      {
        title: 'HURIA legal aid and human-rights support',
        publisher: 'Human Rights Agenda (HURIA)',
        href: 'https://huria.ngo/',
      },
    ],
    relatedSlugs: ['private-reporting-control', 'route-safety-without-exposure'],
  },
  {
    slug: 'route-safety-without-exposure',
    ogImage: '/og/blog-route-safety-without-exposure.jpg',
    seoTitle: 'Anonymous Matatu Route Safety Data',
    tag: 'Route safety',
    title: 'How anonymous matatu route signals can improve safety without exposing riders',
    excerpt:
      'Route accountability should use minimized, aggregated, consented signals, not private evidence or exact journeys.',
    publishedAt: '2026-05-24',
    updatedAt: '2026-11-01',
    authorName: 'SafeRide by Esheria editorial team',
    reviewStatus: 'Route-data governance and safeguarding review required before production publication',
    editorialNote:
      'HURIA staff used the partner dashboard in the pilot. Public route signals are a separate idea that has not been built, not a verified ranking or a live score.',
    sections: [
      {
        heading: 'A route signal should never contain a survivor’s private evidence',
        paragraphs: [
          'A rider may want an incident to contribute to a broader picture of safety without sharing a statement, audio recording, photograph, name, or exact journey. SafeRide separates the private incident record from the smaller set of fields considered for route-level analysis.',
          'That separation should be enforced in the data model and visible in the interface. A route signal must be a separate, voluntary choice. It should never be created automatically because someone drafted a report or asked for support.',
        ],
      },
      {
        heading: 'Collect the minimum detail needed to understand a pattern',
        paragraphs: [
          'Useful route information may include a broad corridor, a time window, and a high-level incident category. It should exclude names, contact details, raw media, exact pickup or destination points, and any combination of details that could identify a rider.',
          'Data minimization also means declining information that is interesting but unnecessary. Each field should have a documented purpose, retention period, access rule, and deletion path before the pilot treats it as part of a public-safety dataset.',
        ],
      },
      {
        heading: 'Do not publish route scores until the sample is large enough to be responsible',
        paragraphs: [
          'A small number of reports can create a misleading impression about a route, operator, neighbourhood, or time of day. A responsible index needs minimum sample thresholds, clear time windows, uncertainty notes, duplicate controls, and a process for reviewing bias or coordinated misuse.',
          'The absence of reports cannot prove that a route is safe. Differences in phone access, awareness, willingness to report, and partner coverage can all affect the data. Public explanations should make those limits as visible as any score or trend.',
        ],
      },
      {
        heading: 'Route information matters only when partners act on it',
        paragraphs: [
          'The partner dashboard groups shared cases by broad Mombasa subcounty for case follow-up. It is not a route index and must not be used as a public route ranking.',
          'A dashboard is not an outcome. Transport operators, survivor-support organizations, civic partners, and regulators need a documented process for reviewing patterns, choosing a proportionate response, and reporting what changed without exposing individual riders.',
          'SafeRide’s pilot should measure whether partners understand the signal, whether an action follows, and whether riders experience the change as safer. Until that evidence exists, route pages should describe the method and limitations rather than claim verified safety rankings.',
        ],
      },
    ],
    actions: [
      {
        label: 'See how the partner dashboard works',
        href: '/partner-dashboard',
        body: 'See who can open shared reports, what they see, and what the dashboard leaves out.',
      },
      {
        label: 'Compare private and anonymous data',
        href: '/blog/private-reporting-control',
        body: 'Understand why personal evidence and community route signals need separate consent decisions.',
      },
      {
        label: 'Work on a responsible pilot',
        href: '/partners',
        body: 'Review the roles available for operators, survivor-support organizations, researchers, and funders.',
      },
    ],
    sources: [
      {
        title: 'SafeRide in the UNICEF Femtech Ventures cohort',
        publisher: 'UNICEF Office of Innovation',
        href: 'https://www.unicef.org/innovation/femtech-cohort-1',
      },
    ],
    relatedSlugs: ['private-reporting-control', 'kenya-support-pathways'],
  },
] as const satisfies readonly Guide[];

export function getGuide(slug: string) {
  return GUIDES.find((guide) => guide.slug === slug);
}
