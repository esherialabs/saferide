import PageShell from '@/components/PageShell';
import { interiorPageStructuredData } from '@/lib/json-ld';
import { pageMetadata } from '@/lib/metadata';
import { INTERIOR_PAGES } from '@/lib/pages';

export const metadata = pageMetadata({
  title: 'The SafeRide Partner Dashboard',
  description:
    'Where a rider’s shared report reaches named partner staff: signed-in accounts, broad Mombasa areas only, no exact locations, and access set up with each partner directly.',
  path: '/partner-dashboard',
  image: INTERIOR_PAGES['partner-dashboard'].ogImage,
  imageAlt: INTERIOR_PAGES['partner-dashboard'].imageAlt,
});

export default function Page() {
  return (
    <PageShell
      {...INTERIOR_PAGES['partner-dashboard']}
      structuredData={interiorPageStructuredData({ name: 'Partner Dashboard', path: '/partner-dashboard' })}
    />
  );
}
