import Footer from '@/components/Footer';
import Nav from '@/components/Nav';
import PilotGallery from '@/components/PilotGallery';
import { JsonLd, interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';

export const metadata = pageMetadata({
  title: 'The Pilot in Pictures',
  description:
    'Real photographs from SafeRide’s supervised pilot with HURIA in Mombasa: the partner briefing, hands-on demonstrations and a community day.',
  path: '/pilot',
});

export default function Page() {
  return (
    <>
      <Nav />
      <main id="main-content">
        <JsonLd
          id="pilot-structured-data"
          data={interiorPageStructuredData({ name: 'The pilot in pictures', path: '/pilot' })}
        />
        <PilotGallery />
      </main>
      <Footer />
    </>
  );
}
