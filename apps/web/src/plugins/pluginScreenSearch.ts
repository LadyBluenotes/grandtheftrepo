import { useNavigate, useSearch } from "@tanstack/react-router";
import { ProjectId } from "@t3tools/contracts";

/**
 * What a `/plugins/<id>` URL names besides the plugin: the environment (`machine`, as on the
 * Plugins page), the project a screen with a project picker starts on, the screen's tab, and the
 * record open on it. A link such as an attention flag's sets them; a screen reads and changes the
 * tab and record with `usePluginScreenSearch`.
 */
interface PluginScreenSearch {
  readonly machine?: string;
  readonly projectId?: ProjectId;
  readonly tab?: string;
  readonly recordId?: string;
}

/**
 * A search value as the text it stands for; blank means none. The router JSON-parses every value
 * and quotes a string that would parse when it writes a link, so any string a link carries comes
 * back as it was. A hand-typed `recordId=12` or `tab=true` arrives parsed, and is turned back
 * into its text.
 */
const searchText = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.trim().length > 0 ? text : undefined;
};

/** Keeps the four keys a screen reads, as strings, and drops the rest. */
export function validatePluginScreenSearch(raw: Record<string, unknown>): PluginScreenSearch {
  // Environment and project ids are trimmed; tabs and record ids keep their exact text.
  const machine = searchText(raw.machine)?.trim();
  const projectId = searchText(raw.projectId)?.trim();
  const tab = searchText(raw.tab);
  const recordId = searchText(raw.recordId);
  return {
    ...(machine === undefined ? {} : { machine }),
    ...(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) }),
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
    projectId: search.projectId,
    tab: search.tab,
    recordId: search.recordId,
    setTab: (tab: string) => update({ tab, recordId: undefined }),
    setRecordId: (recordId: string | null) => update({ recordId: recordId ?? undefined }),
  };
}
