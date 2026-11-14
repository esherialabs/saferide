import CommunitySpotlight from '@/components/CommunitySpotlight';
import EditorialGrid from '@/components/EditorialGrid';
import Footer from '@/components/Footer';
import FundCTA from '@/components/FundCTA';
import HeroAccordion from '@/components/HeroAccordion';
import ImpactNumbers from '@/components/ImpactNumbers';
import KineticStrip from '@/components/KineticStrip';
import Nav from '@/components/Nav';
import PilotBanner from '@/components/PilotBanner';
import PilotMoment from '@/components/PilotMoment';
import { JsonLd, breadcrumbSchema, graph } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { SITE } from '@/lib/site';

export const metadata = pageMetadata({
  title: "SafeRide — Women's Safety App for Public Transport in Kenya",
  description:
    'Document harassment safely, understand your support options in Kenya, and choose exactly what leaves your phone. Piloted with HURIA in Mombasa in October 2026.',
  path: '/',
  absoluteTitle: true,
});

export default function Home() {
  return (
    <>
      <Nav />
      <main id="main-content">
        <JsonLd id="home-structured-data" data={graph([breadcrumbSchema([])])} />
        <HeroAccordion panels={SITE.heroAccordion} />
        <KineticStrip />
        <PilotBanner />
        <PilotMoment />
        <ImpactNumbers />
        <EditorialGrid />
        <CommunitySpotlight items={SITE.community} />
        <FundCTA />
      </main>
      <Footer />
    </>
  );
}
