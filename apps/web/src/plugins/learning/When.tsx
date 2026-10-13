import { formatRelativeTimeLabel } from "~/timestampFormat";

/** A relative time, with the instant on the element for assistive tech, or a dash when there is none. */
export function When({ at }: { readonly at: string | null }) {
  if (at === null) return <span className="text-muted-foreground">—</span>;
  return <time dateTime={at}>{formatRelativeTimeLabel(at)}</time>;
}
