import LegalDocument from '@/components/LegalDocument';
import { TERMS } from '@/content/legal';
import { pageMetadata } from '@/lib/metadata';

export const metadata = pageMetadata({
  title: TERMS.metaTitle,
  description: TERMS.description,
  path: TERMS.path,
});

export default function Page() {
  return <LegalDocument document={TERMS} />;
}
