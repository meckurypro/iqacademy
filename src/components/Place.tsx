import { place, placeSub, type CentreLike } from "../lib/centre";

/**
 * Student-facing centre label, inline: the town leads in bold and the facility name follows, smaller.
 * It inherits the surrounding colour and size, so it works on muted lines and on the accent card alike.
 * `townOnly` drops the facility name for tight lines (e.g. the instalment reminder).
 */
export default function Place({ centre, townOnly }: { centre: CentreLike; townOnly?: boolean }) {
  const sub = townOnly ? "" : placeSub(centre);
  return <><span className="font-semibold">{place(centre)}</span>{sub && <span className="text-[0.85em]"> · {sub}</span>}</>;
}
