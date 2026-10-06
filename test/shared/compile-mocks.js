const fs = require('fs');
const path = require('path');
const hre = require('hardhat');

// Test-only Solidity sources live under test/mocks/ so contracts/ only holds
// deployable code. They are compiled here with Hardhat's own solc build and
// the same settings as the deployable contracts.
const MOCKS_DIR = path.join(__dirname, '..', 'mocks');
const SOLC_VERSION = '0.8.12';
const SETTINGS = {
  optimizer: { enabled: true, runs: 1000000 },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
};

const cache = new Map();

async function compileMock(fileName, contractName) {
  const key = `${fileName}:${contractName}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  const sourceName = `test/mocks/${fileName}`;
  const input = {
    language: 'Solidity',
    sources: { [sourceName]: { content: fs.readFileSync(path.join(MOCKS_DIR, fileName), 'utf8') } },
    settings: SETTINGS,
  };

  const build = await hre.run('compile:solidity:solc:get-build', { quiet: true, solcVersion: SOLC_VERSION });
  const output = build.isSolcJs
    ? await hre.run('compile:solidity:solcjs:run', { input, solcJsPath: build.compilerPath })
    : await hre.run('compile:solidity:solc:run', { input, solcPath: build.compilerPath });

  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Failed to compile ${sourceName}:\n${errors.map((e) => e.formattedMessage).join('\n')}`);
  }

  const contract = output.contracts[sourceName][contractName];
  const artifact = { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
  cache.set(key, artifact);
  return artifact;
}

module.exports = { compileMock };
