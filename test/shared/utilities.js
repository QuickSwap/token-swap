const { BigNumber } = require('ethers');
const { ethers } = require("hardhat");

function expandTo18Decimals(n) {
  return BigNumber.from(n).mul(BigNumber.from(10).pow(18))
}

async function mineBlocks(n) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send('evm_mine');
  }
}

module.exports = {
  expandTo18Decimals,
  mineBlocks
}