import { useNavigate, useSearch } from "@tanstack/react-router";

/**
 * What a `/plugins/<id>` URL names besides the plugin: the environment (`machine`, as on the
 * Plugins page), the screen's tab, and the record open on it. A link such as an attention flag's
 * sets them; a screen reads and changes the tab and record with `usePluginScreenSearch`.
 */
interface PluginScreenSearch {
  readonly machine?: string;
  readonly tab?: string;
  readonly recordId?: string;
}

const nonBlank = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/**
 * Keeps the three keys a screen reads and drops the rest. The router JSON-parses search values,
 * so a typed `recordId=12` arrives as a number and is kept as the string a link would give.
 */
export function validatePluginScreenSearch(raw: Record<string, unknown>): PluginScreenSearch {
  const machine = nonBlank(raw.machine);
  const tab = nonBlank(raw.tab);
  const recordId =
    typeof raw.recordId === "number" && Number.isFinite(raw.recordId)
      ? String(raw.recordId)
      : nonBlank(raw.recordId);
  return {
    ...(machine === undefined ? {} : { machine }),
    ...(tab === undefined ? {} : { tab }),
    ...(recordId === undefined ? {} : { recordId }),
  };
}

/**
 * The tab and record the URL names, unchecked: each screen falls back from a tab it does not
 * have. Picking a tab closes the open record, which belongs to the tab it was opened on.
 */
export function usePluginScreenSearch() {
  const search = useSearch({ from: "/_chat/plugins/$pluginId" });
  const navigate = useNavigate({ from: "/plugins/$pluginId" });
  const update = (patch: { readonly tab?: string; readonly recordId?: string | undefined }) =>
    void navigate({
      to: ".",
      search: (previous) => validatePluginScreenSearch({ ...previous, ...patch }),
    });
  return {
    tab: search.tab,
    recordId: search.recordId,
    setTab: (tab: string) => update({ tab, recordId: undefined }),
    setRecordId: (recordId: string | null) => update({ recordId: recordId ?? undefined }),
  };
}
