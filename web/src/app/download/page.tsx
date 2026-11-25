import Link from 'next/link';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import { ANDROID_RELEASE, ANDROID_RELEASE_RECORD_PATH, formatBytes } from '@/lib/android-release';
import { JsonLd, breadcrumbSchema, faqPageSchema, graph, softwareApplicationSchema } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { SITE } from '@/lib/site';

export const metadata = pageMetadata({
  title: `Download SafeRide ${ANDROID_RELEASE.appVersion} for Android`,
  absoluteTitle: true,
  description:
    `Download the SafeRide ${ANDROID_RELEASE.appVersion} Android testing preview, verify its SHA-256 checksum, and review safety limits from the October 2026 HURIA pilot in Mombasa.`,
  path: '/download',
});

const installSteps = [
  `Use an Android ${ANDROID_RELEASE.minimumApi === 26 ? '8.0' : `API ${ANDROID_RELEASE.minimumApi}`} or newer phone. The optional on-device assistant needs an arm64 phone; its model needs about ${formatBytes(ANDROID_RELEASE.model.freeStorageBytes)} free, and we recommend 8–10 GB free before setup.`,
  'Build 26 uses the same signing certificate as builds 21, 22 and 23. Install it as an update and keep your app data. If Android reports a signing conflict, do not uninstall or clear data: contact SafeRide to preserve your drafts. The August preview used a different signing key.',
  'Download the signed APK and compare its SHA-256 value before allowing “Install unknown apps” for your trusted browser or file manager.',
  'Open SafeRide, complete onboarding, review permissions, and configure stealth and quick-exit settings before testing.',
  'During the October 2026 pilot, only participants enrolled by HURIA should have submitted real reports. The pilot has ended. Use this public testing preview only with synthetic reports and never enter real survivor evidence.',
];

const pilotNotes = [
  'This is a public testing preview, not a production, emergency-service, UNICEF-approved, or Google Play release. In an emergency, contact emergency services.',
  'Accounts and draft sync use SafeRide’s own server. During the October 2026 pilot, participants tested a consented handoff to HURIA’s caseworker dashboard. Partner sharing and report submission are not live features of this public preview; availability depends on the current deployment. Drafts stay on the phone, encrypted; this public preview does not claim a live send path.',
  `The optional on-device assistant downloads ${formatBytes(ANDROID_RELEASE.model.sizeBytes)} on first use and needs about ${formatBytes(ANDROID_RELEASE.model.freeStorageBytes)} free. Use stable Wi-Fi and keep the device charging.`,
  'Full handset acceptance remains pending, including retained drafts after upgrade, the decoy PIN after restart, photo import, TalkBack and the lower-memory device matrix. Automated build, signature and permission checks passed.',
  'Build 26 keeps off Android backup of the app’s data and no longer requests the display-over-other-apps permission.',
];

const downloadFaqs = [
  {
    question: 'What platform does the SafeRide testing preview support?',
    answer: `This APK is built for Android ${ANDROID_RELEASE.minimumApi === 26 ? '8.0' : `API ${ANDROID_RELEASE.minimumApi}`} or newer phones (${ANDROID_RELEASE.abis.join(', ')}). The optional on-device assistant needs an arm64 phone. iOS is not included.`,
  },
  {
    question: 'Should testers enter real survivor evidence?',
    answer: 'The October 2026 pilot has ended. Use this public preview with synthetic reports; do not enter real survivor evidence unless a new approved deployment instructs otherwise.',
  },
  {
    question: 'Why is the model download much larger than the APK?',
    answer: `The signed APK is ${formatBytes(ANDROID_RELEASE.artifact.sizeBytes)}, while the separate on-device LiteRT-LM model is ${formatBytes(ANDROID_RELEASE.model.sizeBytes)}. The model is designed to download once, be verified locally, and stay available after restart; that flow was confirmed on the August build and has not yet been retested on build 26.`,
  },
] as const;

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main-content" className="bg-white pt-20">
        <JsonLd
          id="download-structured-data"
          data={graph([
            breadcrumbSchema([{ name: 'Download App', path: '/download' }]),
            softwareApplicationSchema(),
            faqPageSchema([...downloadFaqs]),
          ])}
        />
        <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6 lg:px-0 lg:py-20">
          <p className="mb-4 text-sm font-semibold uppercase tracking-normal">Download App</p>
          <h1 className="max-w-5xl font-display text-[clamp(2.75rem,7vw,5.75rem)] font-semibold leading-[0.9] tracking-normal">
            Download SafeRide for Android.
          </h1>
          <p className="mt-8 max-w-3xl text-xl leading-8 text-green-950/80 md:text-2xl md:leading-9">
            {ANDROID_RELEASE.releaseName} is the latest signed, checksum-bound build. Full handset acceptance is still pending. This public preview is for testing with synthetic data. Do not assume partner sharing or report submission is active.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Link href={SITE.apkUrl} target="_blank" rel="noreferrer" className="inline-flex border-3 border-black bg-[#53E17C] px-6 py-4 font-display font-semibold text-green-950 transition hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[5px_5px_0_#0D1B12]">
              Download Android APK
            </Link>
            <Link href={ANDROID_RELEASE.artifact.checksumUrl} target="_blank" rel="noreferrer" className="inline-flex border-3 border-black bg-[#F7EC36] px-6 py-4 font-display font-semibold text-green-950 transition hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[5px_5px_0_#0D1B12]">
              Download SHA-256
            </Link>
            <Link href="/privacy-safety-trust" className="inline-flex border-3 border-black bg-white px-6 py-4 font-display font-semibold text-green-950 transition hover:-translate-x-1 hover:-translate-y-1 hover:shadow-[5px_5px_0_#0D1B12]">
              Review safety notes
            </Link>
          </div>
        </section>

        <section className="border-y-3 border-black bg-[#50C9F0] py-12 md:py-16" aria-labelledby="release-details">
          <div className="mx-auto max-w-[1200px] px-4 sm:px-6 lg:px-0">
            <p className="text-sm font-semibold uppercase tracking-normal">Current testing artifact</p>
            <h2 id="release-details" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
              Verify the exact build before installing.
            </h2>
            <dl className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ['Release', ANDROID_RELEASE.releaseName],
                ['App version', `${ANDROID_RELEASE.appVersion} (code ${ANDROID_RELEASE.versionCode})`],
                ['APK size', formatBytes(ANDROID_RELEASE.artifact.sizeBytes)],
                ['Architecture', ANDROID_RELEASE.abis.join(', ')],
              ].map(([label, value]) => (
                <div key={label} className="border-3 border-black bg-white p-5 shadow-[5px_5px_0_#0D1B12]">
                  <dt className="text-xs font-semibold uppercase tracking-normal text-green-800">{label}</dt>
                  <dd className="mt-2 text-lg font-semibold leading-6">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-6 border-3 border-black bg-white p-6">
              <p className="text-xs font-semibold uppercase tracking-normal text-green-800">APK SHA-256</p>
              <code className="mt-3 block break-all text-sm leading-6 sm:text-base">{ANDROID_RELEASE.artifact.sha256}</code>
              <p className="mt-4 text-sm leading-6 text-green-950/75">
                Source commit <code>{ANDROID_RELEASE.artifact.sourceCommit.slice(0, 12)}</code>; package <code>{ANDROID_RELEASE.packageId}</code>; {ANDROID_RELEASE.artifact.signatureScheme} verified at build; the APK file is served from SafeRide’s public release host, so check its SHA-256 before installing; signing certificate SHA-256 <code className="break-all">{ANDROID_RELEASE.artifact.certificateSha256}</code>.
              </p>
              <Link href={ANDROID_RELEASE_RECORD_PATH} target="_blank" className="mt-4 inline-flex font-semibold underline underline-offset-4">
                View release metadata
              </Link>
            </div>
          </div>
        </section>

        <section className="border-b-3 border-black bg-[#F88539] py-12 md:py-16">
          <div className="mx-auto grid max-w-[1200px] gap-6 px-4 sm:px-6 md:grid-cols-2 lg:px-0">
            <div className="border-3 border-black bg-white p-6 shadow-[6px_6px_0_#0D1B12]">
              <h2 className="font-display text-4xl font-semibold leading-none tracking-normal">Install checklist</h2>
              <ol className="mt-6 grid gap-4">
                {installSteps.map((step, index) => (
                  <li key={step} className="flex gap-4 text-lg leading-7">
                    <span className="grid h-9 w-9 shrink-0 place-items-center border-3 border-black bg-[#F7EC36] font-display font-semibold">{index + 1}</span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </div>
            <div className="border-3 border-black bg-white p-6 shadow-[6px_6px_0_#0D1B12]">
              <h2 className="font-display text-4xl font-semibold leading-none tracking-normal">Testing caveats</h2>
              <ul className="mt-6 grid gap-4">
                {pilotNotes.map((note) => (
                  <li key={note} className="border-l-4 border-green-900 pl-4 text-lg leading-7">{note}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1200px] px-4 py-16 sm:px-6 lg:px-0" aria-labelledby="download-trust">
          <div className="grid gap-6 md:grid-cols-[0.42fr_0.58fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-normal text-green-700">APK trust</p>
              <h2 id="download-trust" className="mt-3 font-display text-[clamp(2.25rem,5vw,4rem)] font-semibold leading-[0.9] tracking-normal">
                Verify before field use.
              </h2>
              <p className="mt-5 text-lg leading-8 text-green-950/75">
                Treat every APK as sensitive software. This page publishes the exact version, byte size, source commit, and SHA-256 needed to detect a stale or modified download.
              </p>
            </div>
            <div className="grid gap-4">
              {downloadFaqs.map((item) => (
                <article key={item.question} className="border-3 border-black p-6">
                  <h3 className="font-display text-2xl font-semibold leading-none tracking-normal">{item.question}</h3>
                  <p className="mt-4 text-lg leading-7 text-green-950/75">{item.answer}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
