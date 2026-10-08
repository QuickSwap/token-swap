// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test test/converters/sources.test.js`.
// Each ratio variant must be the audited TokenSwap source with only the SWAP_RATIO line changed.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const CONTRACTS = path.join(__dirname, "..", "..", "contracts");
const AUDITED_RATIO_LINE = "    uint256 public constant SWAP_RATIO = 1000;";
const VARIANTS = [750, 500, 250];

const readLines = (file) => fs.readFileSync(path.join(CONTRACTS, file), "utf8").split("\n");

describe("TokenSwap ratio variant sources", function () {
  const audited = readLines("TokenSwap.sol");

  it("audited source declares SWAP_RATIO = 1000 exactly once", function () {
    assert.deepStrictEqual(
      audited.filter((line) => line.includes("SWAP_RATIO =")),
      [AUDITED_RATIO_LINE]
    );
  });

  for (const ratio of VARIANTS) {
    it(`ratio-${ratio} differs from the audited source only in the SWAP_RATIO line`, function () {
      const variant = readLines(`ratio-${ratio}/TokenSwap.sol`);
      assert.strictEqual(variant.length, audited.length, "line count differs");

      const differing = audited
        .map((line, index) => ({ index, audited: line, variant: variant[index] }))
        .filter((entry) => entry.audited !== entry.variant);

      assert.deepStrictEqual(differing, [
        {
          index: audited.indexOf(AUDITED_RATIO_LINE),
          audited: AUDITED_RATIO_LINE,
          variant: `    uint256 public constant SWAP_RATIO = ${ratio};`,
        },
      ]);
    });
  }
});
