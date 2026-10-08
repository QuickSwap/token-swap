// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test 'test/deploy/*.test.js'`.
// The Hardhat deploy script refuses Polygon; converter deployments there use the Foundry commands.
const assert = require("assert");
const { describe, it } = typeof global.describe === "function" ? global : require("node:test");

const deploy = require("../../deploy/001_deploy_swap");

function fakeHre(chainId) {
  const calls = [];
  const hre = {
    getChainId: async () => chainId,
    getNamedAccounts: async () => {
      calls.push("getNamedAccounts");
      throw new Error("stop after the chain check");
    },
    deployments: {
      deploy: async () => {
        calls.push("deploy");
      },
    },
  };
  return { hre, calls };
}

describe("Hardhat deploy script on Polygon", function () {
  it("refuses chain 137 before any deployment step and points to the Foundry path", async function () {
    const { hre, calls } = fakeHre("137");
    await assert.rejects(deploy(hre), /chain 137.*forge create/);
    assert.deepStrictEqual(calls, []);
  });

  it("still runs the deployment on other chains", async function () {
    const { hre, calls } = fakeHre("31337");
    await assert.rejects(deploy(hre), /stop after the chain check/);
    assert.deepStrictEqual(calls, ["getNamedAccounts"]);
  });

  it("keeps the deployment function available for tests", function () {
    assert.strictEqual(typeof deploy.deployTokenSwap, "function");
  });
});
