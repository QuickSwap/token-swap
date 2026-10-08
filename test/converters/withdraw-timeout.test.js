// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test test/converters/withdraw-timeout.test.js`.
// Synthetic times only: the real cutover times are deploy-day inputs.
const assert = require("assert");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const {
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
} = require("../../scripts/lib/withdraw-timeout");

const REFERENCE = { number: 50000000, timestamp: 1000000 };
// deadline - reference.timestamp - allowance = 300 s = exactly 100 blocks of 3000 ms.
const BOUNDARY = {
  referenceBlock: REFERENCE,
  outgoingCutover: 1000000 + 600 + 300 + 3600,
  marginSeconds: 3600,
  assumedBlockTimeMs: 3000,
  inclusionAllowanceSeconds: 600,
};

const withInput = (overrides) => ({ ...BOUNDARY, ...overrides });

describe("withdraw timeout constants", function () {
  it("exposes the defaults and minimums", function () {
    assert.strictEqual(DEFAULT_MARGIN_SECONDS, 86400);
    assert.strictEqual(DEFAULT_ASSUMED_BLOCK_TIME_MS, 3000);
    assert.strictEqual(DEFAULT_INCLUSION_ALLOWANCE_SECONDS, 600);
    assert.strictEqual(MIN_MARGIN_SECONDS, 3600);
    assert.strictEqual(MIN_ASSUMED_BLOCK_TIME_MS, 2000);
    assert.strictEqual(MIN_INCLUSION_ALLOWANCE_SECONDS, 60);
    assert.strictEqual(BLOCK_TIME_HEADROOM, 1.25);
  });
});

describe("parseCutover", function () {
  it("accepts a strict UTC timestamp and returns unix seconds", function () {
    assert.strictEqual(parseCutover("2026-12-05T00:00:00Z", "CUTOVER_500"), Date.UTC(2026, 11, 5) / 1000);
    assert.strictEqual(parseCutover("2027-01-05T13:45:07Z", "X"), Date.UTC(2027, 0, 5, 13, 45, 7) / 1000);
  });

  for (const bad of ["2026-12-05", "2026-12-05T00:00:00+01:00", "2026-02-30T00:00:00Z", "2026-12-05T00:00:00.000Z",
    "2026-12-05 00:00:00Z", "2026-12-05T24:00:00Z", " 2026-12-05T00:00:00Z", ""]) {
    it(`refuses ${JSON.stringify(bad)}`, function () {
      assert.throws(() => parseCutover(bad, "CUTOVER_500"), /CUTOVER_500/);
    });
  }

  it("refuses a missing value and non-strings", function () {
    assert.throws(() => parseCutover(undefined, "CUTOVER_250"), /CUTOVER_250 is required/);
    assert.throws(() => parseCutover(null, "CUTOVER_250"), /CUTOVER_250 is required/);
    assert.throws(() => parseCutover(1796428800, "CUTOVER_250"), /CUTOVER_250/);
  });
});

describe("deriveWithdrawDuration", function () {
  it("lands the timeout exactly on the deadline when the window is a whole number of blocks", function () {
    const result = deriveWithdrawDuration(BOUNDARY);
    assert.deepStrictEqual(result, {
      durationBlocks: 100,
      deadline: BOUNDARY.outgoingCutover - 3600,
      latestTimeoutTimestamp: BOUNDARY.outgoingCutover - 3600,
    });
  });

  it("rounds the duration down when the window is not a whole number of blocks", function () {
    const result = deriveWithdrawDuration(withInput({ outgoingCutover: BOUNDARY.outgoingCutover + 2 }));
    assert.strictEqual(result.durationBlocks, 100);
    assert.strictEqual(result.latestTimeoutTimestamp, result.deadline - 2);
    const next = deriveWithdrawDuration(withInput({ outgoingCutover: BOUNDARY.outgoingCutover + 3 }));
    assert.strictEqual(next.durationBlocks, 101);
    assert.strictEqual(next.latestTimeoutTimestamp, next.deadline);
  });

  it("handles block times that are not whole seconds", function () {
    // 300 s at 2100 ms -> floor(142.857) = 142 blocks -> 298.2 s rounded up to 299 s.
    const result = deriveWithdrawDuration(withInput({ assumedBlockTimeMs: 2100 }));
    assert.strictEqual(result.durationBlocks, 142);
    assert.strictEqual(result.latestTimeoutTimestamp, REFERENCE.timestamp + 600 + 299);
    assert.ok(result.latestTimeoutTimestamp <= result.deadline);
  });

  it("never yields a timeout after the deadline over many synthetic inputs", function () {
    let seed = 0x2545f491;
    const next = (max) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    let checked = 0;
    for (let i = 0; i < 5000; i += 1) {
      const timestamp = 1600000000 + next(200000000);
      const input = {
        referenceBlock: { number: next(90000000), timestamp },
        marginSeconds: 3600 + next(200000),
        assumedBlockTimeMs: 2000 + next(8000),
        inclusionAllowanceSeconds: 60 + next(5000),
      };
      input.outgoingCutover = timestamp + input.inclusionAllowanceSeconds + input.marginSeconds + 10 + next(9000000);
      let result;
      try {
        result = deriveWithdrawDuration(input);
      } catch (error) {
        assert.match(error.message, /at least one block/);
        continue;
      }
      checked += 1;
      assert.ok(result.durationBlocks >= 1);
      assert.ok(result.latestTimeoutTimestamp <= result.deadline, JSON.stringify({ input, result }));
      // A deploy mined at the end of the inclusion allowance still meets the deadline; one more block does not.
      const lateDeploy = {
        number: input.referenceBlock.number,
        timestamp: timestamp + input.inclusionAllowanceSeconds,
      };
      const post = (blocks) => assertTimeoutBeforeCutover({
        deployBlock: lateDeploy,
        withdrawTimeout: lateDeploy.number + blocks,
        outgoingCutover: input.outgoingCutover,
        marginSeconds: input.marginSeconds,
        assumedBlockTimeMs: input.assumedBlockTimeMs,
      });
      assert.strictEqual(post(result.durationBlocks).latestTimeoutTimestamp, result.latestTimeoutTimestamp);
      assert.throws(() => post(result.durationBlocks + 1), /after the deadline/);
    }
    assert.ok(checked > 4000, `only ${checked} inputs produced a duration`);
  });

  it("accepts the minimum margin and refuses one second less", function () {
    assert.strictEqual(deriveWithdrawDuration(withInput({ marginSeconds: 3600 })).durationBlocks, 100);
    assert.throws(
      () => deriveWithdrawDuration(withInput({ marginSeconds: 3599 })),
      /marginSeconds must be at least 3600/
    );
  });

  it("accepts the minimum assumed block time and refuses one millisecond less", function () {
    assert.strictEqual(deriveWithdrawDuration(withInput({ assumedBlockTimeMs: 2000 })).durationBlocks, 150);
    assert.throws(
      () => deriveWithdrawDuration(withInput({ assumedBlockTimeMs: 1999 })),
      /assumedBlockTimeMs must be at least 2000/
    );
  });

  it("requires the assumed block time to cover the observed block time with headroom", function () {
    assert.strictEqual(deriveWithdrawDuration(withInput({ observedBlockTimeMs: 2400 })).durationBlocks, 100);
    assert.throws(
      () => deriveWithdrawDuration(withInput({ observedBlockTimeMs: 2401 })),
      /assumedBlockTimeMs 3000 must be at least 3002/
    );
  });

  it("accepts the minimum inclusion allowance and refuses one second less", function () {
    assert.strictEqual(deriveWithdrawDuration(withInput({ inclusionAllowanceSeconds: 60 })).durationBlocks, 280);
    assert.throws(
      () => deriveWithdrawDuration(withInput({ inclusionAllowanceSeconds: 59 })),
      /inclusionAllowanceSeconds must be at least 60/
    );
  });

  it("refuses a deadline that is not after the reference block plus the allowance", function () {
    const atBoundary = REFERENCE.timestamp + 600 + 3600;
    assert.throws(
      () => deriveWithdrawDuration(withInput({ outgoingCutover: atBoundary })),
      /deadline .* must be after/
    );
    assert.throws(
      () => deriveWithdrawDuration(withInput({ outgoingCutover: REFERENCE.timestamp })),
      /deadline .* must be after/
    );
  });

  it("refuses a window shorter than one block", function () {
    const twoSeconds = REFERENCE.timestamp + 600 + 3600 + 2;
    assert.throws(
      () => deriveWithdrawDuration(withInput({ outgoingCutover: twoSeconds })),
      /at least one block/
    );
  });

  for (const field of ["outgoingCutover", "marginSeconds", "assumedBlockTimeMs", "inclusionAllowanceSeconds"]) {
    it(`refuses a missing or invalid ${field}`, function () {
      for (const value of [undefined, null, "3600", -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => deriveWithdrawDuration(withInput({ [field]: value })), new RegExp(field));
      }
    });
  }

  it("refuses a missing or invalid reference block", function () {
    assert.throws(() => deriveWithdrawDuration(withInput({ referenceBlock: undefined })), /referenceBlock/);
    assert.throws(
      () => deriveWithdrawDuration(withInput({ referenceBlock: { number: 1 } })),
      /referenceBlock.timestamp/
    );
    assert.throws(
      () => deriveWithdrawDuration(withInput({ referenceBlock: { number: -1, timestamp: 1 } })),
      /referenceBlock.number/
    );
  });

  it("refuses an invalid observed block time when given", function () {
    assert.throws(() => deriveWithdrawDuration(withInput({ observedBlockTimeMs: "2000" })), /observedBlockTimeMs/);
    assert.throws(() => deriveWithdrawDuration(withInput({ observedBlockTimeMs: -5 })), /observedBlockTimeMs/);
    assert.throws(() => deriveWithdrawDuration(withInput({ observedBlockTimeMs: 0 })), /observedBlockTimeMs/);
  });

  it("refuses being called without an argument", function () {
    assert.throws(() => deriveWithdrawDuration(), /referenceBlock/);
  });
});

describe("assertTimeoutBeforeCutover", function () {
  const post = (overrides) => ({
    deployBlock: REFERENCE,
    withdrawTimeout: REFERENCE.number + 100,
    outgoingCutover: BOUNDARY.outgoingCutover,
    marginSeconds: 3600,
    assumedBlockTimeMs: 3000,
    ...overrides,
  });

  it("passes when the timeout lands exactly on the deadline", function () {
    const deadline = BOUNDARY.outgoingCutover - 3600;
    // The deploy block equals the reference, so 100 blocks leave the 600 s allowance unused.
    assert.deepStrictEqual(assertTimeoutBeforeCutover(post({ withdrawTimeout: REFERENCE.number + 300 })), {
      latestTimeoutTimestamp: deadline,
      deadline,
    });
  });

  it("fails one block past the deadline", function () {
    assert.throws(
      () => assertTimeoutBeforeCutover(post({ withdrawTimeout: REFERENCE.number + 301 })),
      /after the deadline/
    );
  });

  it("accepts string and BigNumber-like timeouts", function () {
    const asString = assertTimeoutBeforeCutover(post({ withdrawTimeout: String(REFERENCE.number + 300) }));
    const bigNumberLike = { toString: () => String(REFERENCE.number + 300) };
    assert.deepStrictEqual(assertTimeoutBeforeCutover(post({ withdrawTimeout: bigNumberLike })), asString);
    assert.throws(() => assertTimeoutBeforeCutover(post({ withdrawTimeout: "0x10" })), /withdrawTimeout/);
    assert.throws(() => assertTimeoutBeforeCutover(post({ withdrawTimeout: undefined })), /withdrawTimeout/);
  });

  it("fails when the timeout is not after the deploy block", function () {
    assert.throws(
      () => assertTimeoutBeforeCutover(post({ withdrawTimeout: REFERENCE.number })),
      /must be after the deploy block/
    );
  });

  it("absorbs a deploy mined up to the inclusion allowance after the reference block", function () {
    const { durationBlocks, deadline } = deriveWithdrawDuration(BOUNDARY);
    const deployBlock = { number: REFERENCE.number + 200, timestamp: REFERENCE.timestamp + 600 };
    const result = assertTimeoutBeforeCutover(post({
      deployBlock,
      withdrawTimeout: deployBlock.number + durationBlocks,
    }));
    assert.strictEqual(result.latestTimeoutTimestamp, deadline);
  });

  it("fails when the deploy is mined later than the inclusion allowance", function () {
    const { durationBlocks } = deriveWithdrawDuration(BOUNDARY);
    const deployBlock = { number: REFERENCE.number + 201, timestamp: REFERENCE.timestamp + 601 };
    assert.throws(
      () => assertTimeoutBeforeCutover(post({ deployBlock, withdrawTimeout: deployBlock.number + durationBlocks })),
      /after the deadline/
    );
  });

  it("refuses unsafe settings", function () {
    assert.throws(() => assertTimeoutBeforeCutover(post({ marginSeconds: 3599 })), /marginSeconds/);
    assert.throws(() => assertTimeoutBeforeCutover(post({ assumedBlockTimeMs: 1999 })), /assumedBlockTimeMs/);
    assert.throws(() => assertTimeoutBeforeCutover(post({ deployBlock: { number: 1 } })), /deployBlock.timestamp/);
    assert.throws(() => assertTimeoutBeforeCutover(post({ outgoingCutover: undefined })), /outgoingCutover/);
  });
});

describe("estimateTimestampAtBlock", function () {
  it("projects a later block from the reference block", function () {
    assert.strictEqual(estimateTimestampAtBlock({ referenceBlock: REFERENCE, block: REFERENCE.number + 100, blockTimeMs: 2100 }),
      REFERENCE.timestamp + 210);
    assert.strictEqual(estimateTimestampAtBlock({ referenceBlock: REFERENCE, block: REFERENCE.number + 3, blockTimeMs: 2100 }),
      REFERENCE.timestamp + 7);
  });

  it("accepts string block numbers and refuses blocks before the reference", function () {
    assert.strictEqual(
      estimateTimestampAtBlock({ referenceBlock: REFERENCE, block: String(REFERENCE.number + 10), blockTimeMs: 2000 }),
      REFERENCE.timestamp + 20
    );
    assert.throws(
      () => estimateTimestampAtBlock({ referenceBlock: REFERENCE, block: REFERENCE.number - 1, blockTimeMs: 2000 }),
      /block/
    );
  });
});
