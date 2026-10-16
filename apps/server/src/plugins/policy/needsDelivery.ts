/**
 * Whether one agent still needs one accepted policy installed. A delivery is current when it is
 * of the accepted version, carries today's `RULES.md`, has been verified and went into the file
 * the agent reads now; anything else, including no delivery at all, needs one.
 */
export const needsDelivery = (input: {
  /** The accepted version. */
  readonly version: number;
  /** sha256 of today's `RULES.md`, as `renderBlock` hashes it. */
  readonly rulesHash: string;
  /** The agent's instruction file today; a delivery into another file, such as its old home, is not current. */
  readonly targetPath: string;
  /** The agent's `deliveries` row for the policy, if it has one. */
  readonly delivery:
    | {
        readonly version: number;
        readonly rulesHash: string;
        readonly targetPath: string;
        readonly verifiedAt: string | null;
      }
    | undefined;
}) =>
  input.delivery === undefined ||
  input.delivery.version !== input.version ||
  input.delivery.rulesHash !== input.rulesHash ||
  input.delivery.targetPath !== input.targetPath ||
  input.delivery.verifiedAt === null;
