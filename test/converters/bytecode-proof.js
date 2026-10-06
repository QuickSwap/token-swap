// Runs under `npx hardhat test` only (reads compiled artifacts). Checks the instruction-level proof
// for every ratio variant against the audited TokenSwap build.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { disassemble } = require("../../scripts/lib/bytecode-diff");
const { loadBuild, proveVariant, settingsFailures, VARIANTS, AUDITED, EXPECTED_RATIO_SITES } = require("../../scripts/prove-ratio-variants");

const AUDITED_ARTIFACT = path.join(__dirname, "..", "..", "artifacts", "contracts", "TokenSwap.sol", "TokenSwap.json");
const pushValue = (formatted) => parseInt(formatted.split(" 0x")[1], 16);
const immutableStarts = (build) =>
  Object.values(build.immutableReferences).flat().map(({ start }) => start).sort((a, b) => a - b);

describe("TokenSwap ratio variant bytecode proof", function () {
  let audited;

  before(function () {
    if (!fs.existsSync(AUDITED_ARTIFACT)) {
      console.log("    Skipping bytecode proof: artifacts are missing, run `npx hardhat compile` first.");
      this.skip();
    }
    audited = loadBuild(AUDITED.source);
  });

  it("audited build uses the audited compiler profile", function () {
    assert.deepStrictEqual(settingsFailures(audited), []);
  });

  for (const { source, ratio } of VARIANTS) {
    describe(`ratio-${ratio}`, function () {
      let variant;
      let result;

      before(function () {
        variant = loadBuild(source);
        result = proveVariant(audited, variant, ratio);
      });

      it("differs only in the ratio constant and moved code offsets and lengths", function () {
        assert.strictEqual(result.ok, true, result.failures.join("\n"));
        assert.strictEqual(result.sections.runtime.instructionCount.audited, result.sections.runtime.instructionCount.variant);
        assert.strictEqual(result.sections.init.instructionCount.audited, result.sections.init.instructionCount.variant);
      });

      it("changes the ratio at exactly two runtime sites", function () {
        assert.deepStrictEqual(EXPECTED_RATIO_SITES, { runtime: 2, init: 0 });
        assert.strictEqual(result.sections.runtime.counts.ratio, 2);
        assert.strictEqual(result.sections.init.counts.ratio, 0);
        const ratioSites = result.sections.runtime.differences.filter((d) => d.kind === "ratio");
        assert.deepStrictEqual(ratioSites.map((d) => pushValue(d.audited)), [AUDITED.ratio, AUDITED.ratio]);
        assert.deepStrictEqual(ratioSites.map((d) => pushValue(d.variant)), [ratio, ratio]);
      });

      if (ratio !== 250) {
        it("moves no code offsets or lengths", function () {
          assert.deepStrictEqual(result.counts, { ratio: 2, "code-offset": 0, "code-length": 0 });
          assert.deepStrictEqual(immutableStarts(variant), immutableStarts(audited));
        });
      } else {
        it("moves exactly the jump targets that follow the first ratio site", function () {
          const firstRatio = result.sections.runtime.differences.find((d) => d.kind === "ratio");
          const instructions = disassemble(audited.sections.runtime);
          const jumpdests = new Set(instructions.filter((i) => i.name === "JUMPDEST").map((i) => i.offset));
          const movedTargets = instructions.filter(
            (i) => i.name.startsWith("PUSH") && jumpdests.has(parseInt(i.data || "0", 16)) && parseInt(i.data, 16) > firstRatio.auditedOffset
          );
          const offsets = result.sections.runtime.differences.filter((d) => d.kind === "code-offset");
          assert.ok(offsets.length > 0);
          assert.deepStrictEqual(offsets.map((d) => d.index), movedTargets.map((i) => i.index));
          assert.ok(offsets.every((d) => d.detail === "runtime JUMPDEST"));
        });

        it("moves the init code immutable positions to the variant's immutable references", function () {
          const moved = result.sections.init.differences.filter((d) => d.kind === "code-offset");
          assert.ok(moved.every((d) => /^immutable \d+\[\d+\] start$/.test(d.detail)));
          const pairs = moved.map((d) => [pushValue(d.audited), pushValue(d.variant)]);
          const auditedStarts = immutableStarts(audited);
          const variantStarts = immutableStarts(variant);
          for (const [from, to] of pairs) {
            assert.strictEqual(variantStarts[auditedStarts.indexOf(from)], to, `immutable position ${from} -> ${to}`);
          }
          assert.ok(pairs.length > 0);
        });

        it("moves the runtime and creation lengths in the init code", function () {
          const lengths = result.sections.init.differences.filter((d) => d.kind === "code-length");
          const shrink = audited.artifact.deployedBytecode.length / 2 - variant.artifact.deployedBytecode.length / 2;
          assert.strictEqual(shrink, 2);
          assert.ok(lengths.length > 0);
          for (const d of lengths) assert.strictEqual(pushValue(d.audited) - pushValue(d.variant), shrink);
          assert.deepStrictEqual(
            [...new Set(lengths.map((d) => d.detail))].sort(),
            ["creation length", "full runtime length"]
          );
        });
      }
    });
  }
});
