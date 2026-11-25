import { ANDROID_RELEASE } from '@/lib/android-release';
import { BRAND_NAME, PARENT_ORG, SITE, canonicalUrl } from '@/lib/site';

export type JsonLdNode = Record<string, unknown>;

export type BreadcrumbItem = {
  name: string;
  path: `/${string}`;
};

type BlogPost = (typeof SITE.updates)[number];

const brandId = `${canonicalUrl('/')}#brand`;
const websiteId = `${canonicalUrl('/')}#website`;
const appId = `${canonicalUrl('/download')}#software`;

function jsonLdString(data: JsonLdNode) {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

export function JsonLd({ data, id = 'structured-data' }: { data: JsonLdNode; id?: string }) {
  return (
    <script id={id} type="application/ld+json">
      {jsonLdString(data)}
    </script>
  );
}

export function graph(nodes: JsonLdNode[]): JsonLdNode {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes,
  };
}

export function organizationSchema(): JsonLdNode {
  return {
    '@type': 'Organization',
    '@id': PARENT_ORG.schemaId,
    name: PARENT_ORG.name,
    url: PARENT_ORG.url,
    email: SITE.contactEmail,
    contactPoint: [
      {
        '@type': 'ContactPoint',
        contactType: 'SafeRide enquiries',
        email: SITE.contactEmail,
        areaServed: 'KE',
        availableLanguage: ['en'],
      },
    ],
    brand: { '@id': brandId },
    sameAs: ['https://www.linkedin.com/company/esheria/'],
  };
}

export function brandSchema(): JsonLdNode {
  return {
    '@type': 'Brand',
    '@id': brandId,
    name: SITE.name,
    alternateName: BRAND_NAME,
    description: SITE.description,
    url: canonicalUrl('/'),
    logo: `${SITE.url}/icon.png`,
    sameAs: [SITE.github, SITE.huggingface],
  };
}

export function websiteSchema(): JsonLdNode {
  return {
    '@type': 'WebSite',
    '@id': websiteId,
    name: SITE.name,
    alternateName: BRAND_NAME,
    url: canonicalUrl('/'),
    publisher: { '@id': PARENT_ORG.schemaId },
    about: { '@id': brandId },
    inLanguage: 'en-KE',
  };
}

export function breadcrumbSchema(items: BreadcrumbItem[]): JsonLdNode {
  const withHome = [{ name: 'Home', path: '/' as const }, ...items];

  return {
    '@type': 'BreadcrumbList',
    itemListElement: withHome.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: canonicalUrl(item.path),
    })),
  };
}

export function articleSchema(post: BlogPost): JsonLdNode {
  return {
    '@type': 'Article',
    '@id': `${canonicalUrl(`/blog/${post.slug}`)}#article`,
    headline: post.title,
    description: post.excerpt,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    inLanguage: 'en-KE',
    url: canonicalUrl(`/blog/${post.slug}`),
    mainEntityOfPage: canonicalUrl(`/blog/${post.slug}`),
    author: {
      '@type': 'Organization',
      name: post.authorName,
      url: canonicalUrl('/story'),
    },
    publisher: { '@id': PARENT_ORG.schemaId },
    about: { '@id': brandId },
    isPartOf: { '@id': websiteId },
    citation: post.sources.map((source) => source.href),
    image: [`${SITE.url}${post.ogImage ?? '/og.png'}`],
  };
}

export function softwareApplicationSchema(): JsonLdNode {
  return {
    '@type': 'SoftwareApplication',
    '@id': appId,
    name: 'SafeRide Android',
    applicationCategory: 'SafetyApplication',
    operatingSystem: 'Android',
    softwareVersion: `${ANDROID_RELEASE.appVersion} (${ANDROID_RELEASE.versionCode})`,
    url: canonicalUrl('/download'),
    downloadUrl: SITE.apkUrl,
    fileSize: ANDROID_RELEASE.artifact.sizeBytes,
    brand: { '@id': brandId },
    publisher: { '@id': PARENT_ORG.schemaId },
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/LimitedAvailability',
    },
  };
}

export function blogCollectionSchema(): JsonLdNode {
  return {
    '@type': 'CollectionPage',
    '@id': `${canonicalUrl('/blog')}#collection`,
    name: 'SafeRide Guides',
    url: canonicalUrl('/blog'),
    inLanguage: 'en-KE',
    isPartOf: { '@id': websiteId },
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: SITE.updates.map((post, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        url: canonicalUrl(`/blog/${post.slug}`),
        name: post.title,
      })),
    },
  };
}

export function contactPageSchema(): JsonLdNode {
  return {
    '@type': 'ContactPage',
    '@id': `${canonicalUrl('/contact')}#contactpage`,
    name: 'Contact SafeRide',
    url: canonicalUrl('/contact'),
    inLanguage: 'en-KE',
    isPartOf: { '@id': websiteId },
    about: { '@id': brandId },
  };
}

export function faqPageSchema(
  mainEntity: Array<{
    question: string;
    answer: string;
  }>,
): JsonLdNode {
  return {
    '@type': 'FAQPage',
    mainEntity: mainEntity.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

export function interiorPageStructuredData({
  name,
  path,
  faqs = [],
}: {
  name: string;
  path: `/${string}`;
  faqs?: Array<{ question: string; answer: string }>;
}): JsonLdNode {
  const nodes = [breadcrumbSchema([{ name, path }])];

  if (faqs.length > 0) {
    nodes.push(faqPageSchema(faqs));
  }

  return graph(nodes);
}

export function siteStructuredData(): JsonLdNode {
  return graph([organizationSchema(), brandSchema(), websiteSchema()]);
}
