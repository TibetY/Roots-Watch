// Parsing helpers for Salesforce Commerce Cloud (SFRA) product pages —
// roots.com is the one this was written against.
//
// Two things give SFRA away, and both are load-bearing here:
//
//   1. PDP URLs look like `/ca/en/<slug>-<masterId>.html`
//   2. Variants are selected with `?dwvar_<masterId>_<attribute>=<value>`
//
// SFRA also exposes a JSON endpoint, `Product-Variation`, that the PDP itself
// calls whenever you click a swatch. Its response lists every value of every
// variation attribute with a `selectable` flag — that flag is the site's own
// answer to "can this be added to the cart right now", which is exactly the
// question we're asking. So the preferred path is: load the PDP, find the
// endpoint in the markup, call it, read `selectable`.
//
// Everything else in this file is fallback for when that path breaks (markup
// changes, the endpoint moves, a bot wall serves us a different page). Each
// extractor reports a confidence level, and every one of them is allowed to
// answer "unknown" — a wrong "in stock" costs the user a pointless trip to a
// sold-out page, and a wrong "out of stock" means they miss the restock
// entirely, so guessing is worse than admitting we couldn't tell.
//
// Pure functions only, no I/O — which is why this is the part with real tests.

/** Availability of a single size. */
export const IN_STOCK = "in_stock" as const;
export const OUT_OF_STOCK = "out_of_stock" as const;
export const UNKNOWN = "unknown" as const;

export type SizeStatus = typeof IN_STOCK | typeof OUT_OF_STOCK | typeof UNKNOWN;
export type Confidence = "high" | "low";

/** One size as the page lists it. */
export type PageSize = { value: string; label: string; status: SizeStatus };

/** What an extractor managed to read off a page. */
export type SizeReading = {
  sizes: PageSize[];
  productName?: string | null;
  confidence: Confidence;
};

/** A size the user asked to watch, matched against what the page had. */
export type WantedSize = {
  wanted: string;
  matchedLabel: string | null;
  status: SizeStatus;
};

export type JsonLdSummary = {
  name: string | null;
  image: string | null;
  price: unknown;
  currency: string | null;
  anyInStock: boolean | null;
};

const SIZE_ATTRIBUTE_IDS = ["size", "kidssize", "shoesize", "babysize"];

/** Pull the master product id and selected colour out of a PDP URL. */
export function parseProductUrl(rawUrl: string): {
  origin: string;
  pid: string | null;
  color: string | null;
  url: string;
} {
  const url = new URL(rawUrl);

  // The dwvar_<pid>_<attr> query params are the most reliable source of the
  // master id, because the slug portion of the path is free-form marketing
  // text and only *usually* ends in the id.
  let pid: string | null = null;
  for (const key of url.searchParams.keys()) {
    const match = key.match(/^dwvar_([^_]+)_/);
    if (match) {
      pid = match[1];
      break;
    }
  }

  if (!pid) {
    const fromPath = url.pathname.match(/-(\w{5,})\.html$/);
    pid = fromPath ? fromPath[1] : null;
  }

  const color = pid ? url.searchParams.get(`dwvar_${pid}_color`) : null;

  return { origin: url.origin, pid, color, url: url.toString() };
}

/** Decode the handful of HTML entities that show up inside URL attributes. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;/g, "'");
}

/**
 * Find the SFRA `Product-Variation` endpoint in PDP markup.
 *
 * The site id and locale segment (`/on/demandware.store/Sites-xxx-Site/en_CA/`)
 * differ per storefront and per environment, so we never hard-code them — we
 * read whatever the page itself is using. If no Product-Variation URL is
 * present we rebuild one from any other Demandware controller URL on the page,
 * since they all share the same prefix.
 */
export function discoverVariationEndpoint(html: string, origin: string): string | null {
  const direct = html.match(
    /(?:https?:\/\/[^/"'\s]+)?\/on\/demandware\.store\/Sites-[^/"'\s]+-Site\/[^/"'\s]+\/Product-Variation/i,
  );
  if (direct) return absolutize(decodeEntities(direct[0]), origin);

  const anyController = html.match(
    /(?:https?:\/\/[^/"'\s]+)?\/on\/demandware\.store\/Sites-[^/"'\s]+-Site\/[^/"'\s]+\//i,
  );
  if (anyController) {
    return absolutize(decodeEntities(anyController[0]) + "Product-Variation", origin);
  }

  return null;
}

function absolutize(path: string, origin: string): string {
  return /^https?:\/\//i.test(path) ? path : new URL(path, origin).toString();
}

/** Build the Product-Variation request for a given colour (and optionally size). */
export function buildVariationUrl(
  endpoint: string,
  { pid, color, size }: { pid: string; color?: string | null; size?: string | null },
): string {
  const url = new URL(endpoint);
  url.searchParams.set("pid", pid);
  if (color) url.searchParams.set(`dwvar_${pid}_color`, color);
  if (size) url.searchParams.set(`dwvar_${pid}_size`, size);
  url.searchParams.set("quantity", "1");
  return url.toString();
}

/**
 * Read size availability out of a Product-Variation JSON response.
 *
 * SFRA marks a variant `selectable: false` when it is out of stock or
 * otherwise unorderable, which is the signal we want. `selected` tells us
 * which value is currently active and is deliberately ignored.
 */
export function extractSizesFromVariationJson(payload: any): SizeReading | null {
  const product = payload?.product ?? payload;
  const attributes = product?.variationAttributes;
  if (!Array.isArray(attributes)) return null;

  const sizeAttr = attributes.find((attr: any) => {
    const id = String(attr?.id ?? attr?.attributeId ?? "").toLowerCase();
    const name = String(attr?.displayName ?? "").toLowerCase();
    return SIZE_ATTRIBUTE_IDS.includes(id) || /size/.test(id) || /size/.test(name);
  });

  if (!sizeAttr || !Array.isArray(sizeAttr.values)) return null;

  const sizes: PageSize[] = sizeAttr.values.map((value: any) => {
    const label = String(value?.displayValue ?? value?.value ?? value?.id ?? "").trim();
    // `selectable` is authoritative when present. When it is missing entirely
    // we must not invent an answer — an absent flag is not a false one.
    const status: SizeStatus =
      typeof value?.selectable === "boolean"
        ? value.selectable
          ? IN_STOCK
          : OUT_OF_STOCK
        : UNKNOWN;
    return { value: String(value?.value ?? value?.id ?? label), label, status };
  });

  return {
    sizes,
    productName: product?.productName ?? product?.name ?? null,
    confidence: "high",
  };
}

// Class names SFRA (and a shop's theme on top of it) uses to grey out a swatch.
const UNAVAILABLE_MARKERS =
  /\b(unselectable|disabled|unavailable|out-of-stock|outofstock|oos|not-available|sold-?out)\b/i;

/**
 * Fallback: read size swatches straight out of the PDP markup.
 *
 * Lower confidence than the JSON endpoint on purpose. We can see a swatch and
 * see that it is *not* marked unavailable, but "no negative marker" is weaker
 * evidence than SFRA telling us `selectable: true` — a restyled theme could
 * drop the class we look for and every size would look buyable.
 */
export function extractSizesFromHtml(html: string): SizeReading {
  const sizes: PageSize[] = [];
  const seen = new Set<string>();

  // Every swatch — colour and size alike — carries data-attr-value. We keep
  // them all and let the caller match the sizes it cares about, rather than
  // trying to infer which group a swatch belongs to from the markup.
  const tagPattern = /<(button|a|li|span|input)\b([^>]*\bdata-attr-value=("|')(.*?)\3[^>]*)>/gi;

  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(html)) !== null) {
    const attrs = match[2];
    const value = decodeEntities(match[4]).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);

    const classMatch = attrs.match(/\bclass=("|')(.*?)\1/i);
    const className = classMatch ? classMatch[2] : "";
    const explicitlyDisabled = /\bdisabled\b/i.test(attrs);
    const dataAvailable = attrs.match(/\bdata-available=("|')(.*?)\1/i);

    let status: SizeStatus;
    if (dataAvailable) {
      status = /^true$/i.test(dataAvailable[2]) ? IN_STOCK : OUT_OF_STOCK;
    } else if (UNAVAILABLE_MARKERS.test(className) || explicitlyDisabled) {
      status = OUT_OF_STOCK;
    } else {
      status = IN_STOCK;
    }

    sizes.push({ value, label: value, status });
  }

  return { sizes, confidence: "low" };
}

/** Parse every JSON-LD block on the page. */
export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern = /<script[^>]*type=("|')application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(match[2].trim()));
    } catch {
      // Malformed JSON-LD is common and never fatal — this is a corroborating
      // source, not the primary one.
    }
  }
  return blocks;
}

/**
 * Pull product name / image / price / offer availability out of JSON-LD.
 *
 * Used for the message body and the dashboard's product card, and as a sanity
 * check on the swatch reading. Offers here often describe the master product
 * rather than per-size variants, so it is never the sole basis for an alert.
 */
export function summarizeJsonLd(blocks: unknown[]): JsonLdSummary | null {
  const flat: any[] = [];
  for (const block of blocks as any[]) {
    if (Array.isArray(block)) flat.push(...block);
    else if (block && typeof block === "object" && Array.isArray(block["@graph"])) {
      flat.push(...block["@graph"]);
    } else if (block) flat.push(block);
  }

  const product = flat.find((node) => {
    const type = node?.["@type"];
    return type === "Product" || (Array.isArray(type) && type.includes("Product"));
  });
  if (!product) return null;

  const offers = product.offers
    ? Array.isArray(product.offers)
      ? product.offers
      : [product.offers]
    : [];

  const anyInStock = offers.some((offer: any) =>
    /instock|limitedavailability/i.test(String(offer?.availability ?? "")),
  );

  return {
    name: typeof product.name === "string" ? product.name : null,
    image: firstImageUrl(product.image),
    price: offers[0]?.price ?? product.offers?.price ?? null,
    currency: offers[0]?.priceCurrency ?? null,
    anyInStock: offers.length ? anyInStock : null,
  };
}

/**
 * JSON-LD's `image` is underspecified — a bare URL string, an array of them,
 * or an ImageObject with a `url` field are all seen in the wild. Used for the
 * product thumbnails; nothing breaks if this comes back null.
 */
function firstImageUrl(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return firstImageUrl(value[0]);
  if (typeof value === "object") {
    const url = (value as { url?: unknown }).url;
    return typeof url === "string" ? url : null;
  }
  return null;
}

/**
 * Normalise a size label for comparison.
 *
 * Kids sizing is written inconsistently — "3", "3T", "3 (3T)", "3Y" all mean
 * the same rack. Strip decoration so a watch for "3" matches all of them, but
 * keep it strict enough that "3" never matches "13".
 */
export function normalizeSize(size: string | number): string {
  const raw = String(size).trim().toUpperCase();
  const withoutParens = raw.replace(/\s*\(.*?\)\s*/g, "");
  return withoutParens.replace(/\s+/g, "").replace(/(?<=\d)[TY]$/, "");
}

/** Match the sizes we're watching against what the page reported. */
export function matchWantedSizes(sizes: PageSize[], wanted: string[]): WantedSize[] {
  return wanted.map((want) => {
    const target = normalizeSize(want);
    const hit = sizes.find(
      (size) => normalizeSize(size.label) === target || normalizeSize(size.value) === target,
    );
    return {
      wanted: String(want),
      matchedLabel: hit ? hit.label : null,
      // A size that isn't on the page at all is unknown, not out of stock:
      // sold-out sizes are sometimes removed from the markup entirely, but so
      // is everything when a bot wall serves us the wrong page.
      status: hit ? hit.status : UNKNOWN,
    };
  });
}
