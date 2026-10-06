// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test test/converters/converter-duration.test.js`.
// Synthetic times only: the real cutover times are deploy-day inputs.
const assert = require("assert");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const { run } = require("../../scripts/converter-duration");
const { parseCutover, deriveWithdrawDuration } = require("../../scripts/lib/withdraw-timeout");

const ENDS = { 750: "2026-12-05T14:00:00Z", 500: "2027-01-05T14:00:00Z", 250: "2027-02-05T14:00:00Z" };
const BASE = {
  "--block-number": "95000000",
  "--block-timestamp": "1791300000",
  "--observed-block-time-ms": "2100",
  "--end-750": ENDS[750],
  "--end-500": ENDS[500],
  "--end-250": ENDS[250],
};
const argv = (overrides = {}) =>
  Object.entries({ ...BASE, ...overrides }).filter(([, v]) => v !== undefined).flat();

describe("converter-duration CLI", function () {
  it("matches deriveWithdrawDuration for each ratio", function () {
    const result = run(argv());
    assert.deepStrictEqual(result.converters.map((c) => c.ratio), [750, 500, 250]);
    for (const converter of result.converters) {
      const expected = deriveWithdrawDuration({
        referenceBlock: { number: 95000000, timestamp: 1791300000 },
        outgoingCutover: parseCutover(ENDS[converter.ratio], "end"),
        marginSeconds: 86400,
        assumedBlockTimeMs: 3000,
        inclusionAllowanceSeconds: 600,
        observedBlockTimeMs: 2100,
      });
      assert.strictEqual(converter.durationBlocks, expected.durationBlocks);
      assert.strictEqual(converter.deadline, new Date(expected.deadline * 1000).toISOString());
      assert.strictEqual(converter.latestTimeout, new Date(expected.latestTimeoutTimestamp * 1000).toISOString());
      assert.ok(converter.estimatedTimeout < converter.latestTimeout);
    }
  });

  it("refuses a missing cutover", function () {
    assert.throws(() => run(argv({ "--end-500": undefined })), /--end-500 is required/);
  });

  it("refuses a missing block input", function () {
    assert.throws(() => run(argv({ "--observed-block-time-ms": undefined })), /--observed-block-time-ms is required/);
  });

  it("refuses out-of-order cutovers", function () {
    assert.throws(() => run(argv({ "--end-500": ENDS[750] })), /end-750 < end-500 < end-250/);
    assert.throws(() => run(argv({ "--end-250": "2027-01-01T00:00:00Z" })), /end-750 < end-500 < end-250/);
  });

  it("refuses an assumed block time below the observed headroom", function () {
    assert.throws(() => run(argv({ "--observed-block-time-ms": "2500" })), /assumedBlockTimeMs 3000 must be at least 3125/);
  });
});
