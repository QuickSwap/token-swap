// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test test/converters/bytecode-diff.test.js`.
// Handcrafted bytecode cases for the instruction-level variant comparison.
const assert = require("assert");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const {
  disassemble,
  formatInstruction,
  stripMetadata,
  splitCreationCode,
  compareVariant,
  compareRuntimeWithOnchain,
} = require("../../scripts/lib/bytecode-diff");

const hex2 = (value) => value.toString(16).padStart(4, "0");

// PUSH2 ratio; PUSH2 <jumpdest>; JUMP; STOP; JUMPDEST; STOP
const AUDITED_RUNTIME = "6103e8" + "610008" + "56" + "00" + "5b" + "00";
// Same program with the ratio as PUSH1 0xfa: the JUMPDEST moves from 0x08 to 0x07.
const VARIANT_250_RUNTIME = "60fa" + "610007" + "56" + "00" + "5b" + "00";
const METADATA = "a16400" + "0003";

const section = (runtime, initCode = "") => ({ initCode, runtime, metadata: "" });

// Init code: CODECOPY the full runtime from the end of the init code, write one value at a runtime
// position (the JUMPDEST byte), and read the creation size for constructor arguments.
function initCodeFor(runtime) {
  const runtimeFullLength = runtime.length / 2 + METADATA.length / 2;
  const jumpdest = disassemble(runtime).find((ins) => ins.name === "JUMPDEST").offset;
  const build = (initLength) =>
    "61" + hex2(initLength + runtimeFullLength) + // creation length
    "61" + hex2(runtimeFullLength) + // runtime length
    "61" + hex2(initLength) + // runtime start
    "6000" + "39" + // PUSH1 0, CODECOPY
    "61" + hex2(jumpdest) + // runtime position
    "52" + // MSTORE
    "61" + hex2(runtimeFullLength) + "6000" + "f3" + "fe"; // RETURN, INVALID
  const length = build(0).length / 2;
  return build(length);
}

describe("disassemble", function () {
  it("reads PUSH0 without data and PUSH32 with 32 data bytes", function () {
    const code = "5f" + "7f" + "11".repeat(32) + "00";
    const instructions = disassemble("0x" + code);
    assert.deepStrictEqual(instructions.map((ins) => ins.name), ["PUSH0", "PUSH32", "STOP"]);
    assert.strictEqual(instructions[0].size, 1);
    assert.strictEqual(instructions[0].data, "");
    assert.strictEqual(instructions[1].offset, 1);
    assert.strictEqual(instructions[1].size, 33);
    assert.strictEqual(instructions[1].data, "11".repeat(32));
    assert.strictEqual(instructions[2].offset, 34);
    assert.strictEqual(instructions[2].index, 2);
  });

  it("marks a trailing push whose data runs past the end as truncated", function () {
    const instructions = disassemble("00" + "62" + "abcd");
    assert.strictEqual(instructions.length, 2);
    assert.strictEqual(instructions[1].name, "PUSH3");
    assert.strictEqual(instructions[1].data, "abcd");
    assert.strictEqual(instructions[1].truncated, true);
    assert.strictEqual(instructions[1].size, 3);
  });

  it("returns no instructions for empty code", function () {
    assert.deepStrictEqual(disassemble("0x"), []);
  });

  it("formats pushes with their data and unknown opcodes as hex", function () {
    const [push, unknown] = disassemble("6103e8" + "0c");
    assert.strictEqual(formatInstruction(push), "PUSH2 0x03e8");
    assert.strictEqual(formatInstruction(unknown), "0x0c");
  });

  it("rejects malformed hex", function () {
    assert.throws(() => disassemble("0x123"), /hex/);
    assert.throws(() => disassemble("zz"), /hex/);
  });
});

describe("stripMetadata", function () {
  it("removes the CBOR tail described by the last two bytes", function () {
    const { code, metadata } = stripMetadata("0x" + AUDITED_RUNTIME + METADATA);
    assert.strictEqual(code, AUDITED_RUNTIME);
    assert.strictEqual(metadata, METADATA);
  });

  it("rejects a declared length longer than the code", function () {
    assert.throws(() => stripMetadata("00" + "a1" + "00ff"), /metadata length/);
  });

  it("rejects a tail that is not a CBOR map", function () {
    assert.throws(() => stripMetadata("00" + "0102" + "0002"), /CBOR map/);
  });

  it("splits creation code into init code, runtime and metadata", function () {
    const runtimeFull = AUDITED_RUNTIME + METADATA;
    const parts = splitCreationCode({ bytecode: "0x" + "6000" + runtimeFull, deployedBytecode: "0x" + runtimeFull });
    assert.deepStrictEqual(parts, { initCode: "6000", runtime: AUDITED_RUNTIME, metadata: METADATA });
    assert.throws(
      () => splitCreationCode({ bytecode: "0x6000", deployedBytecode: "0x" + runtimeFull }),
      /does not end with the runtime/
    );
  });
});

describe("compareVariant", function () {
  const compare = (audited, variant, variantRatio = 250) =>
    compareVariant({ audited, variant, auditedRatio: 1000, variantRatio });

  it("accepts identical code with no differences", function () {
    const report = compare(section(AUDITED_RUNTIME), section(AUDITED_RUNTIME), 1000);
    assert.strictEqual(report.ok, true, report.failures.join("\n"));
    assert.deepStrictEqual(report.sections.runtime.differences, []);
    assert.deepStrictEqual(report.counts, { ratio: 0, "code-offset": 0, "code-length": 0 });
  });

  it("accepts a ratio change with the same push width", function () {
    const variant = "6102ee" + AUDITED_RUNTIME.slice(6);
    const report = compare(section(AUDITED_RUNTIME), section(variant), 750);
    assert.strictEqual(report.ok, true, report.failures.join("\n"));
    assert.deepStrictEqual(report.sections.runtime.differences, [
      { index: 0, auditedOffset: 0, variantOffset: 0, audited: "PUSH2 0x03e8", variant: "PUSH2 0x02ee", kind: "ratio" },
    ]);
  });

  it("accepts a PUSH2 to PUSH1 ratio change with the shifted jump target", function () {
    const report = compare(section(AUDITED_RUNTIME), section(VARIANT_250_RUNTIME));
    assert.strictEqual(report.ok, true, report.failures.join("\n"));
    assert.deepStrictEqual(report.sections.runtime.differences, [
      { index: 0, auditedOffset: 0, variantOffset: 0, audited: "PUSH2 0x03e8", variant: "PUSH1 0xfa", kind: "ratio" },
      { index: 1, auditedOffset: 3, variantOffset: 2, audited: "PUSH2 0x0008", variant: "PUSH2 0x0007", kind: "code-offset" },
    ]);
    assert.deepStrictEqual(report.counts, { ratio: 1, "code-offset": 1, "code-length": 0 });
  });

  it("accepts init code whose runtime length, creation length and runtime positions move", function () {
    const audited = { initCode: initCodeFor(AUDITED_RUNTIME), runtime: AUDITED_RUNTIME, metadata: METADATA };
    const variant = { initCode: initCodeFor(VARIANT_250_RUNTIME), runtime: VARIANT_250_RUNTIME, metadata: METADATA };
    const report = compare(audited, variant);
    assert.strictEqual(report.ok, true, report.failures.join("\n"));
    assert.deepStrictEqual(
      report.sections.init.differences.map((d) => [d.index, d.audited, d.variant, d.kind]),
      [
        [0, "PUSH2 0x0026", "PUSH2 0x0025", "code-length"],
        [1, "PUSH2 0x000f", "PUSH2 0x000e", "code-length"],
        [5, "PUSH2 0x0008", "PUSH2 0x0007", "code-offset"],
        [7, "PUSH2 0x000f", "PUSH2 0x000e", "code-length"],
      ]
    );
    assert.deepStrictEqual(report.counts, { ratio: 1, "code-offset": 2, "code-length": 3 });
  });

  it("fails on a changed opcode", function () {
    const variant = VARIANT_250_RUNTIME.slice(0, -2) + "01";
    const report = compare(section(AUDITED_RUNTIME), section(variant));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime\[5\] .*opcode STOP -> ADD/);
  });

  it("fails on an unexplained push value change", function () {
    const audited = "6103e8" + "602a" + "00";
    const variant = "60fa" + "602b" + "00";
    const report = compare(section(audited), section(variant));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime\[1\] .*PUSH1 0x2a -> PUSH1 0x2b is not a ratio, code offset or code length/);
  });

  it("fails on a ratio change in the wrong direction", function () {
    const report = compare(section("6102ee00"), section("6103e800"));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /PUSH2 0x02ee -> PUSH2 0x03e8/);
  });

  it("fails on a push width change without a value change", function () {
    const report = compare(section("6103e8" + "602a" + "00"), section("60fa" + "61002a" + "00"));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime\[1\] .*PUSH1 0x2a -> PUSH2 0x002a/);
  });

  it("fails on a jump target that does not map to the moved instruction", function () {
    const variant = "60fa" + "610006" + "56" + "00" + "5b" + "00";
    const report = compare(section(AUDITED_RUNTIME), section(variant));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime\[1\] .*PUSH2 0x0008 -> PUSH2 0x0006/);
  });

  it("fails on a jump target left unchanged when its instruction moved", function () {
    const variant = "60fa" + "610008" + "56" + "00" + "5b" + "00";
    const report = compare(section(AUDITED_RUNTIME), section(variant));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime\[1\] .*jump destination 0x0008 moved to 0x0007/);
  });

  it("fails on a differing instruction count", function () {
    const report = compare(section(AUDITED_RUNTIME), section(VARIANT_250_RUNTIME + "00"));
    assert.strictEqual(report.ok, false);
    assert.match(report.failures.join("\n"), /runtime: instruction count differs \(6 vs 7\)/);
  });
});

describe("compareRuntimeWithOnchain", function () {
  // PUSH32 <immutable>; STOP
  const compiledRuntime = "7f" + "00".repeat(32) + "00";
  const onchainRuntime = "7f" + "ab".repeat(32) + "00";
  const references = { 7: [{ start: 1, length: 32 }] };

  it("accepts code that differs only in immutable ranges and metadata", function () {
    const result = compareRuntimeWithOnchain({
      compiled: compiledRuntime + METADATA,
      onchain: "0x" + onchainRuntime + "a16401" + "0003",
      immutableReferences: references,
    });
    assert.deepStrictEqual(result, { ok: true, length: 34 });
  });

  it("reports the first differing byte outside immutable ranges", function () {
    const result = compareRuntimeWithOnchain({
      compiled: compiledRuntime + METADATA,
      onchain: onchainRuntime.slice(0, -2) + "01" + METADATA,
      immutableReferences: references,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /first difference at byte 33/);
  });

  it("reports a length difference", function () {
    const result = compareRuntimeWithOnchain({
      compiled: compiledRuntime + METADATA,
      onchain: onchainRuntime + "00" + METADATA,
      immutableReferences: references,
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /length differs \(34 vs 35\)/);
  });
});
