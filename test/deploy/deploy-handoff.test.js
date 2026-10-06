// Runs under `npx hardhat test` (mocha globals) and standalone with `node --test 'test/deploy/*.test.js'`.
// Exercises the ownership handoff in deployTokenSwap against fake Hardhat runtime objects.
const assert = require("assert");
const { describe, it, beforeEach, afterEach } = typeof global.describe === "function"
  ? global
  : require("node:test");

const deployTokenSwap = require("../../deploy/001_deploy_swap");

const { EXPECTED_TARGETS } = deployTokenSwap.checks;
const polygon = EXPECTED_TARGETS["137"];
const SAFE = polygon.OWNER;
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const THIRD_PARTY = "0x00000000000000000000000000000000000000e2";
const TOKEN_SWAP = "0x00000000000000000000000000000000000000c3";
const DEPLOYMENT_BLOCK = 95000000;
const DURATION = 1036800;

function fakeHre({ owner, ownerAfterTransfer = SAFE }) {
  const state = {
    owner,
    transferCalls: [],
  };

  const tokenSwap = {
    quick: async () => polygon.QUICK.address,
    quickX: async () => polygon.QUICKX.address,
    withdrawTimeout: async () => ({ toString: () => String(DEPLOYMENT_BLOCK + DURATION) }),
    owner: async () => state.owner,
    transferOwnership: async (newOwner) => {
      state.transferCalls.push(newOwner);
      return {
        wait: async () => {
          state.owner = ownerAfterTransfer;
        },
      };
    },
  };

  const tokens = {
    [polygon.QUICK.address.toLowerCase()]: polygon.QUICK,
    [polygon.QUICKX.address.toLowerCase()]: polygon.QUICKX,
  };

  function FakeContract(address) {
    const token = tokens[address.toLowerCase()];
    this.symbol = async () => token.symbol;
    this.decimals = async () => token.decimals;
  }

  const hre = {
    getNamedAccounts: async () => ({ deployer: DEPLOYER }),
    getChainId: async () => "137",
    deployments: {
      getArtifact: async () => ({ abi: [], bytecode: "0x", deployedBytecode: "0x" }),
      // Reused deployment: the handoff path is identical to a fresh deploy without the verification wait.
      deploy: async () => ({
        address: TOKEN_SWAP,
        newlyDeployed: false,
        receipt: { blockNumber: DEPLOYMENT_BLOCK },
      }),
    },
    ethers: {
      provider: {
        getCode: async () => "0x6080",
        getTransactionReceipt: async () => ({ blockNumber: DEPLOYMENT_BLOCK }),
      },
      Contract: FakeContract,
      getSigner: async (address) => ({ address }),
      getContractAt: async (name, address) => {
        assert.strictEqual(name, "contracts/TokenSwap.sol:TokenSwap");
        assert.strictEqual(address, TOKEN_SWAP);
        return tokenSwap;
      },
    },
    run: async () => {
      throw new Error("verification is not expected for a reused deployment");
    },
  };

  return { hre, state };
}

describe("deployTokenSwap ownership handoff", function () {
  let savedDuration;
  let savedLog;

  beforeEach(function () {
    savedDuration = process.env.TOKEN_SWAP_DURATION_BLOCKS;
    process.env.TOKEN_SWAP_DURATION_BLOCKS = String(DURATION);
    savedLog = console.log;
    console.log = () => {};
  });

  afterEach(function () {
    if (savedDuration === undefined) {
      delete process.env.TOKEN_SWAP_DURATION_BLOCKS;
    } else {
      process.env.TOKEN_SWAP_DURATION_BLOCKS = savedDuration;
    }
    console.log = savedLog;
  });

  it("transfers ownership to the Safe once when the deployer owns the contract", async function () {
    const { hre, state } = fakeHre({ owner: DEPLOYER });
    await deployTokenSwap(hre);
    assert.deepStrictEqual(state.transferCalls, [SAFE]);
    assert.strictEqual(state.owner, SAFE);
  });

  it("does not transfer when the Safe already owns the contract", async function () {
    const { hre, state } = fakeHre({ owner: SAFE });
    await deployTokenSwap(hre);
    assert.deepStrictEqual(state.transferCalls, []);
  });

  it("refuses when a third party owns the contract", async function () {
    const { hre, state } = fakeHre({ owner: THIRD_PARTY });
    await assert.rejects(deployTokenSwap(hre), /Deployed TokenSwap owner\(\) is 0x00000000000000000000000000000000000000e2/);
    assert.deepStrictEqual(state.transferCalls, []);
  });

  it("fails when the owner read back after the transfer is not the Safe", async function () {
    const { hre, state } = fakeHre({ owner: DEPLOYER, ownerAfterTransfer: THIRD_PARTY });
    await assert.rejects(
      deployTokenSwap(hre),
      new RegExp(`TokenSwap owner is ${THIRD_PARTY}, expected ${SAFE}`)
    );
    assert.deepStrictEqual(state.transferCalls, [SAFE]);
  });
});
