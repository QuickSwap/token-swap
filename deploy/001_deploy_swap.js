const { ethers } = require("hardhat");
const hre = require("hardhat");
require('dotenv').config()  // Store environment-specific variable from '.env' to process.env

const { getConfig } = require("../config");

function waitforme(milisec) {
  return new Promise(resolve => {
      setTimeout(() => { resolve('') }, milisec);
  })
}

module.exports = async ({getNamedAccounts, deployments, getChainId}) => {
    const {deploy} = deployments;
    const {deployer} = await getNamedAccounts();
    const artifact = await deployments.getArtifact("TokenSwap");
    const chainId = await getChainId();
    console.log(chainId)
    const config = getConfig(chainId);
    const args = [config.QUICK, config.QUICKX, config.DURATION, config.SWAP_RATIO];

    const result = await deploy('TokenSwap', {
      from: deployer,
      contract: {
        abi:artifact.abi,
        bytecode:artifact.bytecode,
        deployedBytecode:artifact.deployedBytecode
      },
      args,
      log: true,
      skipIfAlreadyDeployed: true
    });
    
    if (result.newlyDeployed && chainId !== 31337) {
      
      const tokenSwap = await ethers.getContract("TokenSwap");
      await waitforme(20000); 
      await hre.run("verify:verify", {
        address: tokenSwap.address,
        constructorArguments: args,
      });
    }
    
  };
  module.exports.tags = ['TokenSwap'];