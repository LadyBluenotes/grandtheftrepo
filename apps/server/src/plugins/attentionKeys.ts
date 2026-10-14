/**
 * Whether an open attention flag keyed `key` is raised on a project rather than on a thread. A
 * flag of that kind carries the project id as part of its key, so a key that ends in
 * `:<projectId>`, such as a budget's `budget:<id>:<projectId>`, or has it as a segment, such as a
 * delivery drift flag's `policy:<projectId>:…`, `knowledge:<projectId>:…` or
 * `promotion:<projectId>:<promotionId>`, belongs to that project. A `policy:*:` key is a policy of
 * the whole environment, so it belongs to every project. The board's attention strip and the
 * weekly report both attribute flags with this.
 */
export const flagKeyedToProject = (key: string, projectId: string) =>
  key.endsWith(`:${projectId}`) || key.includes(`:${projectId}:`) || flagKeyedToEveryProject(key);

/** A `policy:*:` key: a policy of the whole environment, which every project's board lists. */
export const flagKeyedToEveryProject = (key: string) => key.startsWith("policy:*:");
