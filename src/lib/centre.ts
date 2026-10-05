// Students think in locations ("Okota"), not facility names ("Brainstorm Academy"),
// so the location leads and the facility name supports it.
export type CentreLike = { name: string; city?: string | null; address?: string | null };

const clean = (s?: string | null) => s?.trim() || "";

/** The headline: city if we have one, otherwise the address, otherwise the facility name. */
export const place = (c: CentreLike) => clean(c.city) || clean(c.address) || c.name;

/** The supporting line: facility name, plus the street address when it adds something. */
export const placeSub = (c: CentreLike) => {
  const head = place(c);
  const street = clean(c.city) && clean(c.address) ? clean(c.address) : "";
  return [head === c.name ? "" : c.name, street].filter(Boolean).join(" · ");
};

/** Plain-text label for <select> options and search: "Okota · Brainstorm Academy". */
export const placeLabel = (c: CentreLike) => [place(c), place(c) === c.name ? "" : c.name].filter(Boolean).join(" · ");
