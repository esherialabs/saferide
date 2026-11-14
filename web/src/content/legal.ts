/**
 * SafeRide's public privacy notice and terms for the HURIA pilot.
 *
 * Successors to the engineering drafts in content/legal/{privacy-policy,terms}/2026-07-draft.1/en.md
 * (listed in config/privacy/privacy-controls.v1.json, which this file does not change).
 * Every statement about the system is taken from the code and configuration it describes:
 * - sharing with HURIA: src/i18n/resources/en.product.v1.json `partnerSharing`,
 *   apps/api/src/services/partnerCaseView.ts, apps/api/src/routes/partnerCases.ts;
 * - callback number and withdrawal: infra/postgres/migrations/007_partner_dashboard.sql;
 * - retention: `retentionPolicies` in config/privacy/privacy-controls.v1.json
 *   (control version privacy-controls.2026-07-30.2) and migration 008;
 * - malware scanning: `malwareScanPolicy` / `evidenceDownloadGate` in the same file,
 *   apps/api/src/services/evidenceQuarantine.ts;
 * - hosting and backups: docs/release/saferide-contabo-host-2026-10-19.md.
 *
 * Text written {{ph:key}} is an open legal or operational fact, rendered as a visible
 * "To confirm" marker. Do not replace one with a guess: each needs a decision from the
 * SafeRide owner or legal review. [[label|href]] is a link.
 */

export const LEGAL_PILOT_VERSION = '2026-10-22.pilot.1';
export const LEGAL_PUBLISHED_ON = '2026-10-22';
export const LEGAL_CONTROL_VERSION = 'privacy-controls.2026-07-30.2';
export const HURIA_PHONE = '0769 546 253';

export const LEGAL_PLACEHOLDERS = {
  'effective-date':
    'Effective date of this version, after legal, safeguarding and privacy review sign-off.',
  controller:
    'The legal entity responsible for SafeRide data (the data controller) and its data protection registration details. The website names Esheria Ventures Limited as operator; confirm that it is also the controller.',
  'lawful-basis': 'The lawful basis for each kind of processing described here.',
  'hosting-location': 'The country and data centre of the Contabo server that hosts SafeRide.',
  'staff-access':
    'Which SafeRide or Esheria roles can access data on the server, and the confidentiality terms they work under.',
  'backup-copies': 'Where the off-server encrypted backup copies are kept, and for how long.',
  'log-retention': 'What SafeRide’s server logs contain and how long they are kept.',
  'huria-role':
    'HURIA’s role under data protection law (for example independent controller or processor), the agreement reference, and how HURIA handles information it records outside SafeRide, such as notes from a call.',
  'server-retention': 'How long reports sent to SafeRide are kept. No period has been approved yet.',
  'privacy-contact':
    'The contact for privacy requests. Proposed: saferide@esheria.org, SafeRide’s public inbox. Add a postal address and a data protection officer if required.',
  'response-time': 'How quickly SafeRide responds to a privacy request.',
  'rights-and-regulator':
    'The applicable data protection law, the rights it gives, and how to complain to the regulator.',
  eligibility: 'Who may use SafeRide during the pilot (for example minimum age and location).',
  'acceptable-use': 'Rules for acceptable use of SafeRide, if any.',
  liability: 'Warranties and limits of liability.',
  'governing-law': 'Governing law, jurisdiction and how disputes are resolved.',
} as const;

export type LegalPlaceholderKey = keyof typeof LEGAL_PLACEHOLDERS;

/** A paragraph, or a bullet list when it is an array. */
export type LegalBlock = string | readonly string[];

export type LegalSection = {
  id: string;
  title: string;
  blocks: readonly LegalBlock[];
};

export type LegalDocumentContent = {
  kind: 'privacy' | 'terms';
  path: '/privacy' | '/terms';
  title: string;
  metaTitle: string;
  description: string;
  intro: string;
  supersedes: string;
  sections: readonly LegalSection[];
};

export const PRIVACY_NOTICE: LegalDocumentContent = {
  kind: 'privacy',
  path: '/privacy',
  title: 'SafeRide privacy notice',
  metaTitle: 'Privacy Notice (Pilot)',
  description:
    'How SafeRide handles reports in the HURIA pilot: what stays on your phone, what reaches SafeRide’s own server, what HURIA sees, retention and your choices.',
  intro:
    'This notice explains what SafeRide does with your information during the pilot with HURIA (Human Rights Agenda) on the Kenyan Coast. Report content stays on your phone until you choose to send it, and sharing with HURIA is a separate, optional choice.',
  supersedes: 'content/legal/privacy-policy/2026-07-draft.1 (engineering review draft)',
  sections: [
    {
      id: 'who-we-are',
      title: 'Who we are',
      blocks: [
        'SafeRide is a public-interest safety app developed by Esheria Foundation.',
        'Data controller: {{ph:controller}}',
        'Some features in this notice, such as sending a report to SafeRide and sharing it with HURIA, are switched on only when their approvals are in place. If the app does not offer a choice, nothing is sent for it.',
      ],
    },
    {
      id: 'on-your-phone',
      title: 'What stays on your phone',
      blocks: [
        'SafeRide keeps your report draft encrypted on your phone. You decide whether to keep it private, contact a provider, or send it.',
        'Before anything leaves the phone, the app shows you a preview of what each choice sends.',
        'Under Privacy & data you can export or delete the data the app lists there. Deleting data on your phone does not recall anything you have already sent to SafeRide or shared with HURIA.',
      ],
    },
    {
      id: 'what-safe-ride-receives',
      title: 'What SafeRide receives when you send a report',
      blocks: [
        'Only what you choose to send reaches SafeRide’s server:',
        [
          'Your SafeRide account: either an anonymous account the app creates, or your email address and password if you sign up with email. Passwords are stored only as a one-way hash.',
          'For a support referral: the provider and contact method you picked and, if you turned on the support brief, only the details listed in it (incident type, date, general type of place, and whether it is still happening).',
          'For an escalation packet: the packet you prepared, at the redaction level you chose. It contains what happened and your statement, any impact or witness details you added, the time, the place in words, your tags and any vehicle details, your alias if you chose one, and the list of your evidence, including your descriptions and transcripts of any recordings. At the “none” and “light” redaction levels the packet also includes the map coordinates of the place; “heavy” redaction leaves them out.',
          'Evidence files (photos, audio, video and documents) that you choose to upload, when evidence upload is available.',
          'Your consent records: what you agreed to, which version of the wording, when, and when you withdrew.',
          'A callback number, only if you choose to add one for HURIA (see below).',
        ],
        'SafeRide does not use your reports for analytics, research or training AI models, does not publish anonymous route signals from them, and does not send them to third-party AI services during the pilot.',
        'Technical logs: {{ph:log-retention}}',
        'Lawful basis: {{ph:lawful-basis}}',
      ],
    },
    {
      id: 'where-stored',
      title: 'Where your report is stored',
      blocks: [
        'SafeRide runs its own server. The website, the app’s server, its database and the evidence file store all run on one self-hosted server that SafeRide operates on a virtual server rented from Contabo. Location: {{ph:hosting-location}}',
        'SafeRide operates the application and storage on rented Contabo infrastructure. Contabo is the infrastructure hosting provider. Connections to SafeRide use HTTPS. SafeRide’s domain names use Cloudflare’s DNS service; the current deployment does not proxy application traffic through Cloudflare.',
        'Authorised staff may enable optional browser notifications on a trusted device. Browser push services operated by Google, Mozilla or Apple deliver an encrypted, generic alert to that browser. SafeRide sends no report narrative, identity, phone number, case reference or location in these alerts. Browser delivery credentials are encrypted on SafeRide’s server and tied to the staff session. A notification does not confirm that a staff member has read or acted on a report.',
        'The server makes an encrypted backup every day and keeps each one for 14 days. An encrypted copy of each backup is also kept off the server, on a computer controlled by the SafeRide team. {{ph:backup-copies}}',
        'Who at SafeRide can access it: {{ph:staff-access}}',
      ],
    },
    {
      id: 'sharing-with-huria',
      title: 'Sharing with HURIA (optional)',
      blocks: [
        'HURIA (Human Rights Agenda) is SafeRide’s partner on the Coast and, in this pilot, the only partner the app offers. Sharing with HURIA is off unless you turn it on and tick the consent for that report. If you send a report, SafeRide gets it whether or not you share it with HURIA.',
        'If you share, named HURIA staff see the report in the SafeRide partner dashboard. They use individual accounts and passwords, with an authenticator step when their organization requires it. SafeRide routes reports to HURIA only while its recorded agreement is current and intake is enabled.',
        'What HURIA sees:',
        [
          'For an escalation packet: the minimised packet at the redaction level you chose. That is what happened and your statement, any impact or witness details you added, the time, the place in words, your tags and any vehicle details, your alias if you chose one, and the list of your evidence, including your descriptions and transcripts of any recordings (with the masking you chose).',
          'For a support referral: a short brief with the contact method you picked and, if you turned on the support brief, only the details listed there.',
        ],
        'What HURIA does not see:',
        [
          'Your exact location. The map coordinates in your packet are always removed before HURIA sees it. SafeRide also tries to remove coordinates and map links that you type into your own text, but cannot recognise every way of writing a position, so describe places in words.',
          'Evidence files. HURIA sees the list of your evidence, with your descriptions and transcripts, but not the photos, audio, video or documents themselves. Evidence files are not shared with partners during the pilot.',
          'The email address or phone number of your SafeRide account.',
        ],
        'HURIA staff can update the status of your report and add notes in the dashboard. These are stored on SafeRide’s server, and you can follow the status in the app. Every time a HURIA staff member opens a report or a callback number, SafeRide records who did it and when. Those records do not contain your report or anyone’s IP address.',
        'To talk to HURIA, call {{huria-phone}} and quote the reference number the app gives you.',
        'HURIA’s role: {{ph:huria-role}}',
      ],
    },
    {
      id: 'callback-number',
      title: 'Optional callback number',
      blocks: [
        'You can let HURIA call you back by adding a Kenyan mobile number. This is a separate choice with its own consent, and it is off unless you turn it on. Without it, HURIA has no number for you: you call HURIA yourself and quote your reference.',
        'The number is stored encrypted. Authorized HURIA caseworkers can reveal it, and every view is recorded. If you stop sharing, the number is deleted.',
        'Only share a number that is safe for you to be called on. If someone else might answer or check that phone, leave this off and call HURIA yourself.',
      ],
    },
    {
      id: 'withdrawing-consent',
      title: 'Withdrawing consent',
      blocks: [
        'You can stop sharing with HURIA at any time, from the case or from Privacy & data in the app. HURIA then loses access to that report straight away, and any callback number you shared is deleted.',
        'If the app no longer knows which consent belongs to a report, for example after reinstalling SafeRide, you can stop sharing all your reports with HURIA at once.',
        'Withdrawal needs a connection. The app tells you if the server has not confirmed it yet.',
        'Anything HURIA has already done, such as calling you or referring you onward, cannot be undone. Stopping sharing with HURIA does not delete your report from SafeRide; to ask for that, use the contact below.',
      ],
    },
    {
      id: 'malware-scanning',
      title: 'Malware scanning of evidence',
      blocks: [
        'Evidence files uploaded to SafeRide go into quarantine. A file can be downloaded only after its fingerprint (hash) matches the one your phone recorded and an approved malware scanner has reported it clean.',
        'Scanning runs only when a current approved scanner is configured and healthy. Until a matching clean result is recorded, the file stays quarantined. An unavailable scanner or failed scan does not release it. A file the scanner rejects is never released.',
        'Face blurring, metadata removal or other processing you request for a file is not reported as done until SafeRide has evidence that it was done.',
      ],
    },
    {
      id: 'retention',
      title: 'How long information is kept',
      blocks: [
        `These periods come from SafeRide’s privacy controls (version ${LEGAL_CONTROL_VERSION}). Except for the phone setting, every period is pending legal approval, and SafeRide does not yet run automatic time-based deletion on its server.`,
        [
          'On your phone: until you delete it. Automatic deletion after 30 or 90 days is planned but pending legal approval, so it is not available yet.',
          'Reports sent to SafeRide: no retention period has been approved yet. {{ph:server-retention}}',
          'HURIA’s access to a report after HURIA closes it: proposed 90 days, pending legal approval. Until then, access ends when you stop sharing.',
          'Records of HURIA staff opening reports and callback numbers: proposed 730 days (two years), pending legal approval.',
          'Callback number: until you stop sharing, when it is deleted straight away.',
          'Server backups: 14 days on the server. Off-server copies: see “Where your report is stored”.',
        ],
      ],
    },
    {
      id: 'children',
      title: 'Children',
      blocks: [
        'SafeRide is not yet approved to handle reports from children. The pilot does not create accounts for people who tell SafeRide they are under 18.',
      ],
    },
    {
      id: 'your-rights',
      title: 'Your choices and requests',
      blocks: [
        'In the app you can see the consents you have given, withdraw them, and export or delete the data listed under Privacy & data.',
        'To see, correct, export or delete what SafeRide holds about you on its server, contact SafeRide. These requests are handled by the SafeRide team, not yet automatically in the app. Response time: {{ph:response-time}}',
        'Your rights under the law: {{ph:rights-and-regulator}}',
      ],
    },
    {
      id: 'contact',
      title: 'Contact and changes',
      blocks: [
        'Privacy requests: {{ph:privacy-contact}} Please do not send evidence, exact locations or details of what happened by email.',
        'For SafeRide in general, use the [[contact page|/contact]]. To talk to HURIA about a shared report, call {{huria-phone}}.',
        `Each version of this notice has its own version number. This is version ${LEGAL_PILOT_VERSION}. A changed notice gets a new version number on this page.`,
      ],
    },
  ],
};

export const TERMS: LegalDocumentContent = {
  kind: 'terms',
  path: '/terms',
  title: 'SafeRide terms of use',
  metaTitle: 'Terms of Use (Pilot)',
  description:
    'The terms for using the SafeRide pilot: what SafeRide is and is not, optional sharing with HURIA, pilot limits, and the points still under legal review.',
  intro:
    'These terms cover the SafeRide app and website during the pilot with HURIA (Human Rights Agenda) on the Kenyan Coast. Read them with the [[privacy notice|/privacy]].',
  supersedes: 'content/legal/terms/2026-07-draft.1 (engineering review draft)',
  sections: [
    {
      id: 'about',
      title: 'About these terms',
      blocks: [
        'SafeRide is developed by Esheria Foundation.',
        'Legal entity responsible: {{ph:controller}}',
        'Who may use SafeRide: {{ph:eligibility}} The pilot does not create accounts for people who tell SafeRide they are under 18.',
      ],
    },
    {
      id: 'what-saferide-is',
      title: 'What SafeRide is, and what it is not',
      blocks: [
        'SafeRide is a support and reporting tool in a pilot. It helps you record an incident, keep it private, and choose whether to contact a provider or send a report.',
        'SafeRide is not an emergency service, a legal representative, an evidence custodian, a guarantee that a provider will help, or a substitute for professional advice. In an emergency call 999 or 112. The national gender-based violence helpline is 1195.',
        'Provider listings and automated guidance in the app can be incomplete or out of date.',
      ],
    },
    {
      id: 'your-choices',
      title: 'Your choices',
      blocks: [
        'You decide whether to save, share or send a report. Nothing is sent until you choose a pathway and confirm it.',
        'Sharing a report with HURIA is optional and needs its own consent for each report. So does letting HURIA call you back. You can stop sharing at any time; see the [[privacy notice|/privacy#withdrawing-consent]].',
      ],
    },
    {
      id: 'huria',
      title: 'HURIA',
      blocks: [
        'HURIA (Human Rights Agenda) is an independent organisation. Any support HURIA gives you, such as a call, advice or a referral onward, is provided by HURIA. SafeRide only carries the report you chose to share to HURIA’s secure dashboard.',
        'SafeRide cannot guarantee when, or whether, HURIA will respond. To contact HURIA directly, call {{huria-phone}} and quote your reference number.',
        'HURIA’s role: {{ph:huria-role}}',
      ],
    },
    {
      id: 'pilot-limits',
      title: 'Pilot limits',
      blocks: [
        'SafeRide is a pilot. Features can change, pause or be switched off, and the service may be unavailable at times. Sharing with HURIA works only while it is switched on and HURIA is accepting reports. If it is not available, the app tells you, and nothing is shared with HURIA.',
        'Anonymous route maps, research use, model training, analytics and handling reports from children are not part of this pilot.',
      ],
    },
    {
      id: 'acceptable-use',
      title: 'Using SafeRide',
      blocks: [
        'Protect your phone and SafeRide PIN, especially if someone else might see your phone.',
        '{{ph:acceptable-use}}',
      ],
    },
    {
      id: 'open-source',
      title: 'Open source',
      blocks: [
        'SafeRide’s source code is public. The licences for the code, content and models are listed on the [[source and licences page|/open-source]].',
      ],
    },
    {
      id: 'liability',
      title: 'Responsibility and disputes',
      blocks: ['Warranties and liability: {{ph:liability}}', 'Governing law and disputes: {{ph:governing-law}}'],
    },
    {
      id: 'changes',
      title: 'Changes and contact',
      blocks: [
        `Each version of these terms has its own version number. This is version ${LEGAL_PILOT_VERSION}. Changed terms get a new version number on this page.`,
        'Questions about these terms: use the [[contact page|/contact]]. Privacy requests: see the [[privacy notice|/privacy#contact]].',
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS = { privacy: PRIVACY_NOTICE, terms: TERMS } as const;
