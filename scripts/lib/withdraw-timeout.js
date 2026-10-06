// Block-based withdraw timeout for the converter deploys.
// The constructor sets withdrawTimeout = deploy block + duration, and the owner can
// withdraw once block.number > withdrawTimeout. The duration is derived so that,
// at the assumed (slow) average block time, the timeout block is reached no later
// than the outgoing cutover minus a margin. All arithmetic is integer (BigInt).
// Pure Node: no Hardhat import, so it loads under plain `node`.

const DEFAULT_MARGIN_SECONDS = 86400;
const DEFAULT_ASSUMED_BLOCK_TIME_MS = 3000;
const DEFAULT_INCLUSION_ALLOWANCE_SECONDS = 600;
const MIN_MARGIN_SECONDS = 3600;
const MIN_ASSUMED_BLOCK_TIME_MS = 2000;
const MIN_INCLUSION_ALLOWANCE_SECONDS = 60;
// The assumed block time must be at least the observed one times this factor.
const BLOCK_TIME_HEADROOM = 1.25;
const HEADROOM_NUMERATOR = 5n;
const HEADROOM_DENOMINATOR = 4n;

const CUTOVER_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const ceilDiv = (a, b) => (a + b - 1n) / b;

function requireCount(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`${name} is required`);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer, got ${String(value)}`);
  }
  return BigInt(value);
}

function requireBlock(block, name) {
  if (block === undefined || block === null || typeof block !== "object") {
    throw new Error(`${name} is required as { number, timestamp }`);
  }
  return {
    number: requireCount(block.number, `${name}.number`),
    timestamp: requireCount(block.timestamp, `${name}.timestamp`),
  };
}

function requireBlockNumberLike(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`${name} is required`);
  }
  if (typeof value === "number") {
    return requireCount(value, name);
  }
  const text = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`${name} must be a non-negative decimal integer, got "${text}"`);
  }
  return BigInt(text);
}

function requireMinimum(value, minimum, name) {
  if (value < BigInt(minimum)) {
    throw new Error(`${name} must be at least ${minimum}, got ${value}`);
  }
}

// Parses a strict UTC ISO 8601 timestamp (YYYY-MM-DDTHH:MM:SSZ) into unix seconds.
function parseCutover(value, name) {
  if (value === undefined || value === null) {
    throw new Error(`${name} is required as a UTC timestamp YYYY-MM-DDTHH:MM:SSZ`);
  }
  if (typeof value !== "string" || !CUTOVER_PATTERN.test(value)) {
    throw new Error(`${name} must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ, got ${JSON.stringify(value)}`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value.replace("Z", ".000Z")) {
    throw new Error(`${name} is not a valid calendar time, got ${JSON.stringify(value)}`);
  }
  return ms / 1000;
}

// Returns the largest duration whose timeout, for a deploy mined up to
// inclusionAllowanceSeconds after referenceBlock, is reached by
// outgoingCutover - marginSeconds at assumedBlockTimeMs per block.
function deriveWithdrawDuration(input = {}) {
  const reference = requireBlock(input.referenceBlock, "referenceBlock");
  const cutover = requireCount(input.outgoingCutover, "outgoingCutover");
  const margin = requireCount(input.marginSeconds, "marginSeconds");
  const blockTimeMs = requireCount(input.assumedBlockTimeMs, "assumedBlockTimeMs");
  const allowance = requireCount(input.inclusionAllowanceSeconds, "inclusionAllowanceSeconds");

  requireMinimum(margin, MIN_MARGIN_SECONDS, "marginSeconds");
  requireMinimum(blockTimeMs, MIN_ASSUMED_BLOCK_TIME_MS, "assumedBlockTimeMs");
  requireMinimum(allowance, MIN_INCLUSION_ALLOWANCE_SECONDS, "inclusionAllowanceSeconds");

  if (input.observedBlockTimeMs !== undefined) {
    const observed = requireCount(input.observedBlockTimeMs, "observedBlockTimeMs");
    requireMinimum(observed, 1, "observedBlockTimeMs");
    const required = ceilDiv(observed * HEADROOM_NUMERATOR, HEADROOM_DENOMINATOR);
    if (blockTimeMs < required) {
      throw new Error(
        `assumedBlockTimeMs ${blockTimeMs} must be at least ${required} ` +
        `(observedBlockTimeMs ${observed} x ${BLOCK_TIME_HEADROOM})`
      );
    }
  }

  const deadline = cutover - margin;
  const earliestStart = reference.timestamp + allowance;
  if (cutover < margin || deadline <= earliestStart) {
    throw new Error(
      `deadline ${cutover - margin} (outgoingCutover - marginSeconds) must be after ` +
      `referenceBlock.timestamp + inclusionAllowanceSeconds (${earliestStart})`
    );
  }

  const durationBlocks = ((deadline - earliestStart) * 1000n) / blockTimeMs;
  if (durationBlocks < 1n) {
    throw new Error(
      `The window to the deadline is shorter than one block at ${blockTimeMs} ms; ` +
      "the duration must be at least one block"
    );
  }

  const latestTimeoutTimestamp = earliestStart + ceilDiv(durationBlocks * blockTimeMs, 1000n);
  if (latestTimeoutTimestamp > deadline) {
    throw new Error(`Derived timeout ${latestTimeoutTimestamp} is after the deadline ${deadline}`);
  }

  return {
    durationBlocks: Number(durationBlocks),
    deadline: Number(deadline),
    latestTimeoutTimestamp: Number(latestTimeoutTimestamp),
  };
}

// Checks a deployed timeout against the outgoing cutover using the real deploy
// block. Returns the latest expected timeout timestamp and the deadline.
function assertTimeoutBeforeCutover(input = {}) {
  const deployBlock = requireBlock(input.deployBlock, "deployBlock");
  const timeout = requireBlockNumberLike(input.withdrawTimeout, "withdrawTimeout");
  const cutover = requireCount(input.outgoingCutover, "outgoingCutover");
  const margin = requireCount(input.marginSeconds, "marginSeconds");
  const blockTimeMs = requireCount(input.assumedBlockTimeMs, "assumedBlockTimeMs");

  requireMinimum(margin, MIN_MARGIN_SECONDS, "marginSeconds");
  requireMinimum(blockTimeMs, MIN_ASSUMED_BLOCK_TIME_MS, "assumedBlockTimeMs");

  if (timeout <= deployBlock.number) {
    throw new Error(`withdrawTimeout ${timeout} must be after the deploy block ${deployBlock.number}`);
  }
  if (cutover < margin) {
    throw new Error(`outgoingCutover ${cutover} must not be smaller than marginSeconds ${margin}`);
  }

  const deadline = cutover - margin;
  const latest = deployBlock.timestamp + ceilDiv((timeout - deployBlock.number) * blockTimeMs, 1000n);
  if (latest > deadline) {
    throw new Error(
      `withdrawTimeout ${timeout} is reached at ${latest} at ${blockTimeMs} ms per block, ` +
      `after the deadline ${deadline} (outgoingCutover ${cutover} - marginSeconds ${margin})`
    );
  }
  return { latestTimeoutTimestamp: Number(latest), deadline: Number(deadline) };
}

// Projects the timestamp of a later block from a reference block, rounding up.
function estimateTimestampAtBlock(input = {}) {
  const reference = requireBlock(input.referenceBlock, "referenceBlock");
  const block = requireBlockNumberLike(input.block, "block");
  const blockTimeMs = requireCount(input.blockTimeMs, "blockTimeMs");
  if (block < reference.number) {
    throw new Error(`block ${block} must not be before referenceBlock.number ${reference.number}`);
  }
  return Number(reference.timestamp + ceilDiv((block - reference.number) * blockTimeMs, 1000n));
}

module.exports = {
  DEFAULT_MARGIN_SECONDS,
  DEFAULT_ASSUMED_BLOCK_TIME_MS,
  DEFAULT_INCLUSION_ALLOWANCE_SECONDS,
  MIN_MARGIN_SECONDS,
  MIN_ASSUMED_BLOCK_TIME_MS,
  MIN_INCLUSION_ALLOWANCE_SECONDS,
  BLOCK_TIME_HEADROOM,
  parseCutover,
  deriveWithdrawDuration,
  assertTimeoutBeforeCutover,
  estimateTimestampAtBlock,
};
