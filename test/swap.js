const { ethers } = require("hardhat");
const { expect, use } = require("chai");
const { solidity } = require('ethereum-waffle');
const { jestSnapshotPlugin } = require('mocha-chai-jest-snapshot');
const { expandTo18Decimals, mineBlocks } = require('./shared/utilities');

use(solidity)
use(jestSnapshotPlugin())

describe("Token Swap", function () {

  let quick;
  let quickX;
  let tokenSwap;
  let wallet;
  let quickSupply;
  let quickXSupply;
  let duration = 10;
  let swapRatio = 1000;
  const DEAD = "0x000000000000000000000000000000000000dEaD";

  before(async function () {
    this.QUICK = await ethers.getContractFactory("TestToken")
    this.QUICKX = await ethers.getContractFactory("TestToken")
    this.TokenSwap = await ethers.getContractFactory("TokenSwap")

    const signers = await ethers.getSigners()
    wallet = signers[0]
  })

  beforeEach(async function () {
    quickSupply = expandTo18Decimals(10000)
    quickXSupply = expandTo18Decimals(10000000)

    quick = await this.QUICK.deploy("QuickSwap", "QUICK", quickSupply)
    quickX = await this.QUICK.deploy("QuickSwap", "QUICK-X", quickXSupply)
    tokenSwap = await this.TokenSwap.deploy(quick.address, quickX.address, duration, swapRatio)
    
    await quickX.transfer(tokenSwap.address, quickXSupply)
    
  })
  
  it("should be able to swap QUICK to QUICK-X", async function () {
    const tokenAmount = expandTo18Decimals(100)
    const receivedTokenAmount = expandTo18Decimals(100000)

    await quick.approve(tokenSwap.address, tokenAmount)

    await expect(
      tokenSwap.quickToQuickX(tokenAmount)
    )
      .to.emit(quick, 'Transfer')
      .withArgs(wallet.address, DEAD, tokenAmount)
      .to.emit(quickX, 'Transfer')
      .withArgs(tokenSwap.address, wallet.address, receivedTokenAmount)
      .to.emit(tokenSwap, 'QuickToQuickX')
      .withArgs(tokenAmount, receivedTokenAmount, wallet.address)
    
    expect(await quickX.balanceOf(wallet.address)).to.eq(receivedTokenAmount)
    expect(await quick.balanceOf(wallet.address)).to.eq(quickSupply.sub(tokenAmount))
    expect(await quick.balanceOf(tokenSwap.address)).to.eq(0)
    expect(await quickX.balanceOf(tokenSwap.address)).to.eq(quickXSupply.sub(receivedTokenAmount))
  })

  it("should be able to swap QUICK to QUICK-X multiple times", async function () {
    const tokenAmount = expandTo18Decimals(100)
    const receivedTokenAmount = expandTo18Decimals(100000)

    for (let i = 0; i < 4; i++) {
      await quick.approve(tokenSwap.address, tokenAmount)

      await expect(
        tokenSwap.quickToQuickX(tokenAmount)
      )
        .to.emit(quick, 'Transfer')
        .withArgs(wallet.address, DEAD, tokenAmount)
        .to.emit(quickX, 'Transfer')
        .withArgs(tokenSwap.address, wallet.address, receivedTokenAmount)
        .to.emit(tokenSwap, 'QuickToQuickX')
        .withArgs(tokenAmount, receivedTokenAmount, wallet.address)
      
      expect(await quickX.balanceOf(wallet.address)).to.eq(receivedTokenAmount.mul(i + 1))
      expect(await quick.balanceOf(wallet.address)).to.eq(quickSupply.sub(tokenAmount.mul(i + 1)))
      expect(await quick.balanceOf(tokenSwap.address)).to.eq(0)
      expect(await quickX.balanceOf(tokenSwap.address)).to.eq(quickXSupply.sub(receivedTokenAmount.mul(i + 1)))
    }
  })

  it("should be able to swap all QUICK to QUICK-X at once", async function () {
    const tokenAmount = quickSupply
    const receivedTokenAmount = quickXSupply

    await quick.approve(tokenSwap.address, tokenAmount)

    await expect(
      tokenSwap.quickToQuickX(tokenAmount)
    )
      .to.emit(quick, 'Transfer')
      .withArgs(wallet.address, DEAD, tokenAmount)
      .to.emit(quickX, 'Transfer')
      .withArgs(tokenSwap.address, wallet.address, receivedTokenAmount)
      .to.emit(tokenSwap, 'QuickToQuickX')
      .withArgs(tokenAmount, receivedTokenAmount, wallet.address)
    
    expect(await quickX.balanceOf(wallet.address)).to.eq(receivedTokenAmount)
    expect(await quick.balanceOf(wallet.address)).to.eq(quickSupply.sub(tokenAmount))
    expect(await quick.balanceOf(tokenSwap.address)).to.eq(0)
    expect(await quickX.balanceOf(tokenSwap.address)).to.eq(quickXSupply.sub(receivedTokenAmount))
  })

  it("should not allow swapping more then user's QUICK balance", async function () {
    const tokenAmount = quickSupply

    await quick.approve(tokenSwap.address, tokenAmount)

    await quick.transfer(DEAD, 10000)
    
    await expect(tokenSwap.quickToQuickX(tokenAmount)).to.be.revertedWith("ERC20: transfer amount exceeds balance")
    
  })

  it("should not allow owner to withdraw QUICK-X before withdraw timeout", async function () {
    const balance = await quickX.balanceOf(tokenSwap.address);
    
    await expect(tokenSwap.withdrawTokens(quickX.address, balance)).to.be.revertedWith("TokenSwap::withdrawTokens: TIMEOUT_NOT_REACHED")
    
  })

  it("should allow owner to withdraw QUICK-X after withdraw timeout has reached", async function () {
    const tokenAmount = expandTo18Decimals(10000)
    
    await mineBlocks(duration);

    await expect(
      tokenSwap.withdrawTokens(quickX.address, tokenAmount)
    )
      .to.emit(quickX, 'Transfer')
      .withArgs(tokenSwap.address, wallet.address, tokenAmount)
      .to.emit(tokenSwap, 'WithdrawTokens')
      .withArgs(quickX.address, tokenAmount)

      expect(await quickX.balanceOf(wallet.address)).to.eq(tokenAmount)
    
  })

  it("should allow owner to increase withdraw timeout", async function () {
    const currentTimeout = await tokenSwap.withdrawTimeout();
    const newTimeout = currentTimeout.add(10).toNumber()

    await expect(
      tokenSwap.setWithdrawTimeout(newTimeout)
    )
      .to.emit(tokenSwap, 'NewWithdrawTimeout')
      .withArgs(newTimeout)

      expect(await tokenSwap.withdrawTimeout()).to.eq(newTimeout)
    
  })

  it("should not allow owner to decrease withdraw timeout", async function () {
    const currentTimeout = await tokenSwap.withdrawTimeout();
    const newTimeout = currentTimeout.sub(1).toNumber()

    await expect(tokenSwap.setWithdrawTimeout(newTimeout)).to.be.revertedWith("TokenSwap::setWithdrawTimeout: NEW_TIMEOUT_MUST_BE_HIGHER");
  })
})
