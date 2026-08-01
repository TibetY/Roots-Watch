import { describe, expect, it } from 'vitest';

import {
  IN_STOCK,
  OUT_OF_STOCK,
  UNKNOWN,
  buildVariationUrl,
  discoverVariationEndpoint,
  extractJsonLd,
  extractSizesFromHtml,
  extractSizesFromVariationJson,
  matchWantedSizes,
  normalizeSize,
  parseProductUrl,
  summarizeJsonLd,
} from '../src/parse.mjs';

// The watcher can't be tested against the live site from CI (and shouldn't be —
// a test suite that hammers roots.com every push is a bad neighbour), so these
// exercise the parsers against fixtures shaped like Salesforce Commerce Cloud
// output. If the real page ever stops matching these shapes the watcher will
// report "unknown" and alert about itself rather than fail silently.

const PRODUCT_URL =
  'https://www.roots.com/ca/en/roots-x-big-apple-t-shirt-27190104.html?dwvar_27190104_color=12B';

describe('parseProductUrl', () => {
  it('pulls the master id and colour out of a Roots PDP URL', () => {
    const parsed = parseProductUrl(PRODUCT_URL);

    expect(parsed.pid).toBe('27190104');
    expect(parsed.color).toBe('12B');
    expect(parsed.origin).toBe('https://www.roots.com');
  });

  it('falls back to the id in the path when there is no dwvar param', () => {
    const parsed = parseProductUrl('https://www.roots.com/ca/en/some-tee-27190104.html');

    expect(parsed.pid).toBe('27190104');
    expect(parsed.color).toBeNull();
  });
});

describe('discoverVariationEndpoint', () => {
  it('finds a Product-Variation URL embedded in the markup', () => {
    const html = `<div data-url="/on/demandware.store/Sites-roots_ca-Site/en_CA/Product-Variation?pid=27190104&amp;quantity=1"></div>`;

    expect(discoverVariationEndpoint(html, 'https://www.roots.com')).toBe(
      'https://www.roots.com/on/demandware.store/Sites-roots_ca-Site/en_CA/Product-Variation',
    );
  });

  it('rebuilds the endpoint from any other Demandware controller URL', () => {
    const html = `<form action="/on/demandware.store/Sites-roots_ca-Site/en_CA/Cart-AddProduct"></form>`;

    expect(discoverVariationEndpoint(html, 'https://www.roots.com')).toBe(
      'https://www.roots.com/on/demandware.store/Sites-roots_ca-Site/en_CA/Product-Variation',
    );
  });

  it('returns null when the page has no Demandware URLs at all', () => {
    expect(discoverVariationEndpoint('<html><body>blocked</body></html>', 'https://www.roots.com')).toBeNull();
  });
});

describe('buildVariationUrl', () => {
  it('adds the product, colour and size parameters', () => {
    const url = new URL(
      buildVariationUrl('https://www.roots.com/on/demandware.store/Sites-roots_ca-Site/en_CA/Product-Variation', {
        pid: '27190104',
        color: '12B',
        size: '3',
      }),
    );

    expect(url.searchParams.get('pid')).toBe('27190104');
    expect(url.searchParams.get('dwvar_27190104_color')).toBe('12B');
    expect(url.searchParams.get('dwvar_27190104_size')).toBe('3');
  });
});

describe('extractSizesFromVariationJson', () => {
  const payload = {
    product: {
      productName: 'Roots x Big Apple T-Shirt',
      variationAttributes: [
        {
          id: 'color',
          displayName: 'Colour',
          values: [{ id: '12B', displayValue: 'Navy Blue', value: '12B', selectable: true }],
        },
        {
          id: 'size',
          displayName: 'Size',
          values: [
            { id: '2', displayValue: '2', value: '2', selectable: false },
            { id: '3', displayValue: '3', value: '3', selectable: true },
            { id: '5', displayValue: '5', value: '5', selectable: false },
          ],
        },
      ],
    },
  };

  it('maps the selectable flag onto stock status', () => {
    const reading = extractSizesFromVariationJson(payload);

    expect(reading?.confidence).toBe('high');
    expect(reading?.productName).toBe('Roots x Big Apple T-Shirt');
    expect(reading?.sizes).toEqual([
      { value: '2', label: '2', status: OUT_OF_STOCK },
      { value: '3', label: '3', status: IN_STOCK },
      { value: '5', label: '5', status: OUT_OF_STOCK },
    ]);
  });

  it('reports unknown rather than guessing when selectable is absent', () => {
    const reading = extractSizesFromVariationJson({
      product: { variationAttributes: [{ id: 'size', values: [{ id: '3', displayValue: '3' }] }] },
    });

    expect(reading?.sizes[0].status).toBe(UNKNOWN);
  });

  it('returns null when the response has no variation attributes', () => {
    expect(extractSizesFromVariationJson({ product: {} })).toBeNull();
    expect(extractSizesFromVariationJson('<html>bot wall</html>')).toBeNull();
  });
});

describe('extractSizesFromHtml', () => {
  it('treats greyed-out swatches as sold out and the rest as available', () => {
    const html = `
      <div class="size-attribute">
        <button class="swatch-value size-value unselectable" data-attr-value="2">2</button>
        <button class="swatch-value size-value selectable" data-attr-value="3">3</button>
        <button class="swatch-value size-value" data-attr-value="5" disabled>5</button>
        <a class="swatch-value" data-attr-value="6" data-available="false">6</a>
      </div>`;

    const { sizes, confidence } = extractSizesFromHtml(html);

    expect(confidence).toBe('low');
    expect(sizes).toEqual([
      { value: '2', label: '2', status: OUT_OF_STOCK },
      { value: '3', label: '3', status: IN_STOCK },
      { value: '5', label: '5', status: OUT_OF_STOCK },
      { value: '6', label: '6', status: OUT_OF_STOCK },
    ]);
  });

  it('finds nothing in a page with no swatches', () => {
    expect(extractSizesFromHtml('<html><body>Access denied</body></html>').sizes).toEqual([]);
  });
});

describe('normalizeSize', () => {
  it.each([
    ['3', '3'],
    ['3T', '3'],
    [' 3 ', '3'],
    ['3 (3T)', '3'],
    ['5Y', '5'],
    ['XS', 'XS'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeSize(input)).toBe(expected);
  });

  it('does not collapse double-digit sizes into single digits', () => {
    expect(normalizeSize('13')).toBe('13');
    expect(normalizeSize('13')).not.toBe(normalizeSize('3'));
  });
});

describe('matchWantedSizes', () => {
  const sizes = [
    { value: '3', label: '3T', status: IN_STOCK },
    { value: '5', label: '5', status: OUT_OF_STOCK },
  ];

  it('matches watched sizes across labelling styles', () => {
    expect(matchWantedSizes(sizes, ['3', '5'])).toEqual([
      { wanted: '3', matchedLabel: '3T', status: IN_STOCK },
      { wanted: '5', matchedLabel: '5', status: OUT_OF_STOCK },
    ]);
  });

  it('reports a size missing from the page as unknown, not sold out', () => {
    expect(matchWantedSizes(sizes, ['7'])).toEqual([{ wanted: '7', matchedLabel: null, status: UNKNOWN }]);
  });
});

describe('JSON-LD parsing', () => {
  const html = `
    <script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"Product","name":"Roots x Big Apple T-Shirt",
         "offers":{"@type":"Offer","price":"48.00","priceCurrency":"CAD",
                   "availability":"http://schema.org/InStock"}}]}
    </script>
    <script type="application/ld+json">{ not json }</script>`;

  it('reads name, price and availability, ignoring malformed blocks', () => {
    const summary = summarizeJsonLd(extractJsonLd(html));

    expect(summary).toEqual({
      name: 'Roots x Big Apple T-Shirt',
      price: '48.00',
      currency: 'CAD',
      anyInStock: true,
    });
  });

  it('returns null when the page contains no product data', () => {
    expect(summarizeJsonLd(extractJsonLd('<html></html>'))).toBeNull();
  });
});
