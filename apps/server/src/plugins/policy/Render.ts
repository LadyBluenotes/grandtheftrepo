import { POLICY_ENVIRONMENT_PROJECT_ID } from "@t3tools/contracts";

import { blockMarkers, sha256 } from "../InstructionBlocks.ts";

/** The id in the markers: the key alone for the environment-wide project `*`. */
export const blockId = (projectId: string, key: string) =>
  projectId === POLICY_ENVIRONMENT_PROJECT_ID ? key : `${projectId}/${key}`;

/** The markers of one policy's block, by its `blockId`. */
export const policyMarkers = (id: string) => blockMarkers("policy", id);

export interface RenderedBlock {
  readonly text: string;
  /** sha256 of the lines between the header and the end marker. */
  readonly hash: string;
  /** sha256 of the `RULES.md` text the block carries. */
  readonly rulesHash: string;
}

/** Start marker, header, the global rules, a blank line, the policy body, end marker. */
export const renderBlock = (input: {
  readonly id: string;
  readonly rules: string;
  readonly body: string;
  readonly version: number;
}): RenderedBlock => {
  const markers = policyMarkers(input.id);
  const content = `${input.rules.trimEnd()}\n\n${input.body.trimEnd()}\n`;
  const hash = sha256(content);
  const rulesHash = sha256(input.rules);
  const header = `${markers.header}${hash} rules=${rulesHash} version=${input.version} -->`;
  return {
    text: `${markers.start}\n${header}\n${content}${markers.end}`,
    hash,
    rulesHash,
  };
};
