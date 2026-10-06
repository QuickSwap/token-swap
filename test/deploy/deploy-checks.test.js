// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test test/deploy/`.
const assert = require("assert");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const { getConfig, isLocalChain } = require("../../config");
const { checks } = require("../../deploy/001_deploy_swap");
const { EXPECTED_TARGETS, resolveDuration, assertDeployTargets, assertOwner } = checks;

const POLYGON = "137";
const expected = EXPECTED_TARGETS[POLYGON];

function fakeReader(overrides = {}) {
  const tokens = {
    [expected.QUICK.address.toLowerCase()]: { symbol: "QUICK", decimals: 18 },
    [expected.QUICKX.address.toLowerCase()]: { symbol: "QUICK", decimals: 18 },
  };
  const withCode = new Set([...Object.keys(tokens), expected.OWNER.toLowerCase()]);
  return {
    getCode: async (address) => (overrides.noCode || []).some((a) => a.toLowerCase() === address.toLowerCase())
      ? "0x"
      : withCode.has(address.toLowerCase()) ? "0x6080" : "0x",
    readToken: async (address) => ({ ...tokens[address.toLowerCase()], ...(overrides.token || {}) }),
  };
}

describe("deploy config", function () {
  it("maps Polygon to the expected token and owner addresses", function () {
    const config = getConfig(POLYGON);
    assert.strictEqual(config.QUICK, expected.QUICK.address);
    assert.strictEqual(config.QUICKX, expected.QUICKX.address);
    assert.strictEqual(config.OWNER, expected.OWNER);
  });

  it("accepts numeric and string chain ids", function () {
    assert.deepStrictEqual(getConfig(137), getConfig("137"));
    assert.strictEqual(isLocalChain(31337), true);
    assert.strictEqual(isLocalChain("31337"), true);
    assert.strictEqual(isLocalChain("137"), false);
  });

  it("throws for an unknown chain", function () {
    assert.throws(() => getConfig("999999"), /No deploy config for chain 999999/);
  });

  it("does not ship a default duration for Polygon", function () {
    assert.strictEqual(getConfig(POLYGON).DURATION, undefined);
  });
});

describe("resolveDuration", function () {
  it("uses the environment value when set", function () {
    assert.strictEqual(resolveDuration({}, { TOKEN_SWAP_DURATION_BLOCKS: "1036800" }), 1036800);
  });

  it("falls back to the config value", function () {
    assert.strictEqual(resolveDuration({ DURATION: 10 }, {}), 10);
  });

  it("requires a duration when none is configured", function () {
    assert.throws(() => resolveDuration({}, {}), /TOKEN_SWAP_DURATION_BLOCKS/);
  });

  it("rejects non positive or non integer values", function () {
    for (const value of ["0", "-5", "1.5", "abc", "", " 10"]) {
      assert.throws(() => resolveDuration({}, { TOKEN_SWAP_DURATION_BLOCKS: value }), /positive integer/);
    }
  });
});

describe("assertDeployTargets", function () {
  it("passes for the expected Polygon targets", async function () {
    await assertDeployTargets({ chainId: POLYGON, config: getConfig(POLYGON), reader: fakeReader() });
  });

  it("skips on-chain checks on the local chain", async function () {
    await assertDeployTargets({ chainId: "31337", config: {}, reader: null });
  });

  it("refuses a chain without expected targets", async function () {
    await assert.rejects(
      assertDeployTargets({ chainId: "1", config: getConfig("1"), reader: fakeReader() }),
      /No expected deploy targets for chain 1/
    );
  });

  it("refuses a token address that differs from the expected one", async function () {
    const config = { ...getConfig(POLYGON), QUICKX: "0x0000000000000000000000000000000000000001" };
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config, reader: fakeReader() }),
      /QUICKX address mismatch/
    );
  });

  it("refuses a missing owner address", async function () {
    const config = { ...getConfig(POLYGON), OWNER: undefined };
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config, reader: fakeReader() }),
      /OWNER address mismatch/
    );
  });

  it("refuses a token without code", async function () {
    const reader = fakeReader({ noCode: [expected.QUICK.address] });
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config: getConfig(POLYGON), reader }),
      /QUICK has no contract code/
    );
  });

  it("refuses an owner without code", async function () {
    const reader = fakeReader({ noCode: [expected.OWNER] });
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config: getConfig(POLYGON), reader }),
      /OWNER has no contract code/
    );
  });

  it("refuses an unexpected symbol", async function () {
    const reader = fakeReader({ token: { symbol: "OTHER" } });
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config: getConfig(POLYGON), reader }),
      /QUICK symbol mismatch/
    );
  });

  it("refuses unexpected decimals", async function () {
    const reader = fakeReader({ token: { decimals: 6 } });
    await assert.rejects(
      assertDeployTargets({ chainId: POLYGON, config: getConfig(POLYGON), reader }),
      /QUICK decimals mismatch/
    );
  });
});

describe("assertOwner", function () {
  it("accepts the expected owner in any letter case", function () {
    assertOwner(expected.OWNER.toLowerCase(), expected.OWNER);
  });

  it("throws when the owner differs", function () {
    assert.throws(
      () => assertOwner("0x0000000000000000000000000000000000000002", expected.OWNER),
      /TokenSwap owner is 0x0000000000000000000000000000000000000002/
    );
  });
});
