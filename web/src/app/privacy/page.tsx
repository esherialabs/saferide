import LegalDocument from '@/components/LegalDocument';
import { PRIVACY_NOTICE } from '@/content/legal';
import { pageMetadata } from '@/lib/metadata';

export const metadata = pageMetadata({
  title: PRIVACY_NOTICE.metaTitle,
  description: PRIVACY_NOTICE.description,
  path: PRIVACY_NOTICE.path,
});

export default function Page() {
  return <LegalDocument document={PRIVACY_NOTICE} />;
}
