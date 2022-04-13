const fs = require('fs');
const path = require('path');
require('dotenv').config()  // Store environment-specific variable from '.env' to process.env

require('@nomiclabs/hardhat-web3');
require('@nomiclabs/hardhat-solhint');
require('hardhat-gas-reporter');
require('hardhat-contract-sizer');
require("@nomiclabs/hardhat-ethers");
require("@nomiclabs/hardhat-truffle5");
require("@nomiclabs/hardhat-etherscan");
require("hardhat-deploy-ethers");
require('hardhat-deploy');
require("@nomiclabs/hardhat-waffle");
require("solidity-coverage");

for (const f of fs.readdirSync(path.join(__dirname, 'hardhat'))) {
  require(path.join(__dirname, 'hardhat', f));
}

/**
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000000
          }
        }
      },
      {
        version: "0.5.16",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000000
          }
        }
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
    main: 1,
    maker: 2
  },
  networks: {
    hardhat: {
      deploy: ["deploy"],
      loggingEnabled: true
    },
    local: {
			url: 'http://127.0.0.1:8545'
    },
    ropsten: {
      url: 'https://ropsten.infura.io/v3/25828999a1a34c00845f18df8e5053fd',
      accounts: [process.env.PK],
      deploy: ["deploy"]
    },
    rinkeby: {
      url: 'https://rinkeby.infura.io/v3/25828999a1a34c00845f18df8e5053fd',
      accounts: [process.env.PK],
      loggingEnabled: true,
      deploy: ["deploy"]
    },
    mainnet: {
      url: 'https://mainnet.infura.io/v3/25828999a1a34c00845f18df8e5053fd',
      accounts: [process.env.PK],
      gasPrice: 40000000000,
      loggingEnabled: true,
      deploy: ["deploy"]
    },
    polygon: {
      url: "https://polygon-rpc.com/",
      chainId: 137,
      gasPrice: 20000000000,
      accounts: [process.env.PK],
      deploy: ["deploy"]
    }
  },
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  etherscan: {
    // Your API key for Etherscan
    // Obtain one at https://etherscan.io/
    apiKey: process.env.ETHERSCAN_API_KEY
  }
};
