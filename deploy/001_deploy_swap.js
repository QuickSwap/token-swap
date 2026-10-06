// hardhat-deploy loads every file under deploy/ as a deploy script, so the
// pre-deploy checks live in this file and are exported for tests.
// The Hardhat runtime is taken from the deploy function argument (no top-level
// require of "hardhat"), which keeps the checks loadable with plain node.
const { getConfig, isLocalChain } = require("../config");

const ERC20_METADATA_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const EXPECTED_TARGETS = {
  "137": {
    QUICK: { address: "0x831753DD7087CaC61aB5644b308642cc1c33Dc13", symbol: "QUICK", decimals: 18 },
    QUICKX: { address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", symbol: "QUICK", decimals: 18 },
    OWNER: "0x636940D73fCed320B558a08348d7e2fa16bc74aa",
  },
};

const sameAddress = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

const hasCode = (code) => typeof code === "string" && code !== "0x" && code !== "0x0";

function resolveDuration(config, env) {
  const raw = env.TOKEN_SWAP_DURATION_BLOCKS !== undefined
    ? env.TOKEN_SWAP_DURATION_BLOCKS
    : config.DURATION;
  if (raw === undefined) {
    throw new Error("Set TOKEN_SWAP_DURATION_BLOCKS to the withdraw timeout in blocks for this deploy");
  }
  if (!/^[1-9][0-9]*$/.test(String(raw))) {
    throw new Error(`Withdraw timeout must be a positive integer number of blocks, got "${raw}"`);
  }
  if (BigInt(raw) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Withdraw timeout must not exceed the safe integer range, got "${raw}"`);
  }
  return Number(raw);
}

function expectedWithdrawTimeout(deploymentBlock, duration) {
  if (!Number.isSafeInteger(deploymentBlock) || deploymentBlock < 0) {
    throw new Error(`Cannot read the TokenSwap deployment block, got ${deploymentBlock}`);
  }
  return (BigInt(deploymentBlock) + BigInt(duration)).toString();
}

function assertDeployedState(actual, expected) {
  if (!sameAddress(actual.quick, expected.quick)) {
    throw new Error(`Deployed TokenSwap quick() is ${actual.quick}, expected ${expected.quick}`);
  }
  if (!sameAddress(actual.quickX, expected.quickX)) {
    throw new Error(`Deployed TokenSwap quickX() is ${actual.quickX}, expected ${expected.quickX}`);
  }
  if (String(actual.withdrawTimeout) !== String(expected.withdrawTimeout)) {
    throw new Error(
      `Deployed TokenSwap withdrawTimeout() is ${actual.withdrawTimeout}, expected ${expected.withdrawTimeout}`
    );
  }
  if (!expected.owners.some((owner) => sameAddress(actual.owner, owner))) {
    throw new Error(
      `Deployed TokenSwap owner() is ${actual.owner}, expected one of ${expected.owners.join(", ")}`
    );
  }
}

async function assertDeployTargets({ chainId, config, reader }) {
  if (isLocalChain(chainId)) {
    return;
  }
  const expected = EXPECTED_TARGETS[String(chainId)];
  if (!expected) {
    throw new Error(`No expected deploy targets for chain ${chainId}; refusing to deploy`);
  }

  for (const key of ["QUICK", "QUICKX"]) {
    const want = expected[key];
    if (!sameAddress(config[key], want.address)) {
      throw new Error(`${key} address mismatch: config has ${config[key]}, expected ${want.address}`);
    }
    if (!hasCode(await reader.getCode(want.address))) {
      throw new Error(`${key} has no contract code at ${want.address}`);
    }
    const { symbol, decimals } = await reader.readToken(want.address);
    if (symbol !== want.symbol) {
      throw new Error(`${key} symbol mismatch: token reports ${symbol}, expected ${want.symbol}`);
    }
    if (Number(decimals) !== want.decimals) {
      throw new Error(`${key} decimals mismatch: token reports ${decimals}, expected ${want.decimals}`);
    }
  }

  if (!sameAddress(config.OWNER, expected.OWNER)) {
    throw new Error(`OWNER address mismatch: config has ${config.OWNER}, expected ${expected.OWNER}`);
  }
  if (!hasCode(await reader.getCode(expected.OWNER))) {
    throw new Error(`OWNER has no contract code at ${expected.OWNER}`);
  }
}

function assertOwner(actual, expected) {
  if (!sameAddress(actual, expected)) {
    throw new Error(`TokenSwap owner is ${actual}, expected ${expected}`);
  }
}

function chainReader(ethers) {
  return {
    getCode: (address) => ethers.provider.getCode(address),
    readToken: async (address) => {
      const token = new ethers.Contract(address, ERC20_METADATA_ABI, ethers.provider);
      return { symbol: await token.symbol(), decimals: await token.decimals() };
    },
  };
}

async function deployLocalTokens(deploy, deployer, config) {
  const supply = "10000000000000000000000000";
  const quick = await deploy("LocalQUICK", {
    from: deployer, contract: "TestToken", args: ["QuickSwap", "QUICK", supply], log: true,
  });
  const quickX = await deploy("LocalQUICKX", {
    from: deployer, contract: "TestToken", args: ["QuickSwap", "QUICK-X", supply], log: true,
  });
  config.QUICK = quick.address;
  config.QUICKX = quickX.address;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function deployTokenSwap(hre) {
  const { getNamedAccounts, deployments, getChainId, ethers } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();
  const chainId = String(await getChainId());
  const local = isLocalChain(chainId);
  const config = getConfig(chainId);

  if (local && !config.QUICK) {
    await deployLocalTokens(deploy, deployer, config);
  }

  const duration = resolveDuration(config, process.env);
  await assertDeployTargets({ chainId, config, reader: chainReader(ethers) });

  const artifact = await deployments.getArtifact("contracts/TokenSwap.sol:TokenSwap");
  const args = [config.QUICK, config.QUICKX, duration];
  const result = await deploy("TokenSwap", {
    from: deployer,
    contract: {
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
    },
    args,
    log: true,
    skipIfAlreadyDeployed: true,
  });

  const tokenSwap = await ethers.getContractAt("contracts/TokenSwap.sol:TokenSwap", result.address, await ethers.getSigner(deployer));
  const deploymentBlock = result.receipt
    ? result.receipt.blockNumber
    : (await ethers.provider.getTransactionReceipt(result.transactionHash) || {}).blockNumber;
  assertDeployedState(
    {
      quick: await tokenSwap.quick(),
      quickX: await tokenSwap.quickX(),
      withdrawTimeout: (await tokenSwap.withdrawTimeout()).toString(),
      owner: await tokenSwap.owner(),
    },
    {
      quick: config.QUICK,
      quickX: config.QUICKX,
      withdrawTimeout: expectedWithdrawTimeout(deploymentBlock, duration),
      owners: config.OWNER ? [deployer, config.OWNER] : [deployer],
    }
  );

  if (result.newlyDeployed && !local) {
    await wait(20000);
    try {
      await hre.run("verify:verify", { address: result.address, constructorArguments: args });
    } catch (error) {
      console.warn(`Source verification failed, continuing with ownership handoff: ${error.message}`);
    }
  }

  if (!config.OWNER) {
    return;
  }

  const currentOwner = await tokenSwap.owner();
  if (!sameAddress(currentOwner, config.OWNER)) {
    assertOwner(currentOwner, deployer);
    console.log(`Transferring TokenSwap ownership to ${config.OWNER}`);
    const tx = await tokenSwap.transferOwnership(config.OWNER);
    await tx.wait();
  }
  assertOwner(await tokenSwap.owner(), config.OWNER);
  console.log(`TokenSwap at ${result.address} is owned by ${config.OWNER}`);
}

module.exports = deployTokenSwap;
module.exports.tags = ["TokenSwap"];
module.exports.checks = {
  EXPECTED_TARGETS,
  resolveDuration,
  assertDeployTargets,
  assertOwner,
  expectedWithdrawTimeout,
  assertDeployedState,
};
