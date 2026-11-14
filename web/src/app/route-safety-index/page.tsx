import Link from 'next/link';
import type { Metadata } from 'next';
import Footer from '@/components/Footer';
import Nav from '@/components/Nav';

// The route safety index was never built, and its address now belongs to the partner dashboard
// page. This stub keeps old links working without JavaScript: a meta refresh (the metadata API
// would write name="refresh", which browsers ignore) and a visible link. It is noindex and left
// out of the sitemap.
export const metadata: Metadata = {
  title: 'Now the partner dashboard',
  description: 'The route safety index page was replaced by the partner dashboard page.',
  robots: { index: false, follow: true },
};

export default function Page() {
  return (
    <>
      <meta httpEquiv="refresh" content="0; url=/partner-dashboard/" />
      <Nav />
      <main id="main-content" className="bg-white pt-20">
        <section className="mx-auto max-w-[1200px] px-4 py-24 sm:px-6 lg:px-0">
          <h1 className="font-display text-[clamp(2.4rem,5vw,4rem)] font-semibold leading-[0.95] tracking-normal">
            Now the partner dashboard.
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-8 text-black/72">
            The page that was here is replaced by one on how shared reports reach named partner staff.
          </p>
          <Link
            href="/partner-dashboard"
            className="interactive-button mt-8 inline-block border-3 border-black bg-[#53E17C] px-5 py-3 font-display font-semibold text-green-950"
          >
            Go to the partner dashboard
          </Link>
        </section>
      </main>
      <Footer />
    </>
  );
}
