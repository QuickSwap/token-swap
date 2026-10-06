const { ethers } = require('hardhat');
const { expect, use } = require('chai');
const { solidity } = require('ethereum-waffle');
const { expandTo18Decimals, mineBlocks } = require('../shared/utilities');
const { compileMock } = require('../shared/compile-mocks');

use(solidity);

const { BigNumber, constants } = ethers;

// Every deployable converter build, addressed by fully qualified name, with
// the ratio it must apply.
const BUILDS = [
  { fqn: 'contracts/TokenSwap.sol:TokenSwap', ratio: 1000 },
  { fqn: 'contracts/ratio-750/TokenSwap.sol:TokenSwap', ratio: 750 },
  { fqn: 'contracts/ratio-500/TokenSwap.sol:TokenSwap', ratio: 500 },
  { fqn: 'contracts/ratio-250/TokenSwap.sol:TokenSwap', ratio: 250 },
];

const DEAD = '0x000000000000000000000000000000000000dEaD';
const SAFE = '0x636940D73fCed320B558a08348d7e2fa16bc74aa';
const DURATION = 20;
// Explicit gas so a failing call is mined in a known block instead of being
// rejected during gas estimation.
const MINED = { gasLimit: 500000 };

async function latestBlock() {
  return ethers.provider.getBlockNumber();
}

async function mineUntil(blockNumber) {
  const current = await latestBlock();
  if (blockNumber > current) {
    await mineBlocks(blockNumber - current);
  }
  expect(await latestBlock()).to.eq(blockNumber);
}

for (const { fqn, ratio } of BUILDS) {
  describe(`Converter build ${fqn} (ratio ${ratio})`, function () {
    let wallet;
    let user;
    let other;
    let TokenSwap;
    let TestToken;
    let CallbackToken;

    before(async function () {
      [wallet, user, other] = await ethers.getSigners();
      TokenSwap = await ethers.getContractFactory(fqn);
      TestToken = await ethers.getContractFactory('TestToken');
      const { abi, bytecode } = await compileMock('CallbackToken.sol', 'CallbackToken');
      CallbackToken = new ethers.ContractFactory(abi, bytecode, wallet);
    });

    // Deploys old QUICK, new QUICK and the converter, funds the converter with
    // `funding` new QUICK and gives `user` `userQuick` old QUICK.
    async function deploySystem({ quickSupply, quickXSupply, funding, userQuick }) {
      const quick = await TestToken.deploy('QuickSwap', 'QUICK', quickSupply);
      const quickX = await TestToken.deploy('QuickSwap', 'QUICK-X', quickXSupply);
      const tokenSwap = await TokenSwap.deploy(quick.address, quickX.address, DURATION);
      await quickX.transfer(tokenSwap.address, funding);
      await quick.transfer(user.address, userQuick);
      return { quick, quickX, tokenSwap };
    }

    async function balances(tokens, holders) {
      const result = [];
      for (const token of tokens) {
        for (const holder of holders) {
          result.push((await token.balanceOf(holder)).toString());
        }
      }
      return result;
    }

    describe('ratio', function () {
      it('exposes the expected SWAP_RATIO', async function () {
        const { tokenSwap } = await deploySystem({
          quickSupply: 1, quickXSupply: 1, funding: 0, userQuick: 0,
        });
        expect(await tokenSwap.SWAP_RATIO()).to.eq(ratio);
      });
    });

    describe('constructor', function () {
      it('reverts on a zero old QUICK address', async function () {
        const quickX = await TestToken.deploy('QuickSwap', 'QUICK-X', 1);
        await expect(TokenSwap.deploy(constants.AddressZero, quickX.address, DURATION))
          .to.be.revertedWith('Invalid address');
      });

      it('reverts on a zero new QUICK address', async function () {
        const quick = await TestToken.deploy('QuickSwap', 'QUICK', 1);
        await expect(TokenSwap.deploy(quick.address, constants.AddressZero, DURATION))
          .to.be.revertedWith('Invalid address');
      });

      it('stores the tokens, the deployer as owner and withdrawTimeout = deployment block + duration', async function () {
        const quick = await TestToken.deploy('QuickSwap', 'QUICK', 1);
        const quickX = await TestToken.deploy('QuickSwap', 'QUICK-X', 1);
        const tokenSwap = await TokenSwap.deploy(quick.address, quickX.address, DURATION);
        const receipt = await tokenSwap.deployTransaction.wait();

        expect(await tokenSwap.quick()).to.eq(quick.address);
        expect(await tokenSwap.quickX()).to.eq(quickX.address);
        expect(await tokenSwap.owner()).to.eq(wallet.address);
        expect(await tokenSwap.DEAD()).to.eq(DEAD);
        expect(await tokenSwap.withdrawTimeout()).to.eq(receipt.blockNumber + DURATION);
      });
    });

    describe('quickToQuickX', function () {
      it('pays amount * ratio new QUICK and sends the old QUICK to DEAD', async function () {
        const funding = expandTo18Decimals(1000).mul(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: expandTo18Decimals(1000), quickXSupply: funding, funding, userQuick: expandTo18Decimals(1000),
        });
        const amount = expandTo18Decimals(100);
        const paid = amount.mul(ratio);

        await quick.connect(user).approve(tokenSwap.address, amount);
        await expect(tokenSwap.connect(user).quickToQuickX(amount))
          .to.emit(quick, 'Transfer').withArgs(user.address, DEAD, amount)
          .to.emit(quickX, 'Transfer').withArgs(tokenSwap.address, user.address, paid)
          .to.emit(tokenSwap, 'QuickToQuickX').withArgs(amount, paid, user.address);

        expect(await quickX.balanceOf(user.address)).to.eq(paid);
        expect(await quick.balanceOf(user.address)).to.eq(expandTo18Decimals(900));
        expect(await quick.balanceOf(DEAD)).to.eq(amount);
        expect(await quick.balanceOf(tokenSwap.address)).to.eq(0);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(funding.sub(paid));
      });

      it('keeps exact accounting over repeated swaps of different sizes', async function () {
        const funding = expandTo18Decimals(1000).mul(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: expandTo18Decimals(1000), quickXSupply: funding, funding, userQuick: expandTo18Decimals(1000),
        });
        const amounts = [expandTo18Decimals(1), BigNumber.from(1), expandTo18Decimals(250).add(7), BigNumber.from('123456789012345678')];
        let swapped = BigNumber.from(0);

        for (const amount of amounts) {
          const paid = amount.mul(ratio);
          const before = await quickX.balanceOf(tokenSwap.address);

          await quick.connect(user).approve(tokenSwap.address, amount);
          await expect(tokenSwap.connect(user).quickToQuickX(amount))
            .to.emit(quick, 'Transfer').withArgs(user.address, DEAD, amount)
            .to.emit(tokenSwap, 'QuickToQuickX').withArgs(amount, paid, user.address);
          swapped = swapped.add(amount);

          expect(await quickX.balanceOf(tokenSwap.address)).to.eq(before.sub(paid));
          expect(await quickX.balanceOf(user.address)).to.eq(swapped.mul(ratio));
          expect(await quick.balanceOf(DEAD)).to.eq(swapped);
          expect(await quick.balanceOf(tokenSwap.address)).to.eq(0);
        }
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(funding.sub(swapped.mul(ratio)));
      });

      it('swaps a full 1,000,000 old QUICK (1e24 wei) with 18/18 decimals', async function () {
        const amount = expandTo18Decimals(1000000);
        const paid = amount.mul(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: amount, quickXSupply: paid, funding: paid, userQuick: amount,
        });
        expect(await quick.decimals()).to.eq(18);
        expect(await quickX.decimals()).to.eq(18);

        await quick.connect(user).approve(tokenSwap.address, amount);
        await expect(tokenSwap.connect(user).quickToQuickX(amount))
          .to.emit(tokenSwap, 'QuickToQuickX').withArgs(amount, paid, user.address);

        expect(await quickX.balanceOf(user.address)).to.eq(paid);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(0);
        expect(await quick.balanceOf(DEAD)).to.eq(amount);
        expect(await quick.balanceOf(user.address)).to.eq(0);
      });

      it('accepts the largest amount whose payout fits in uint256 and rejects one more', async function () {
        const max = constants.MaxUint256;
        const largest = max.div(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: max, quickXSupply: max, funding: max, userQuick: max,
        });
        await quick.connect(user).approve(tokenSwap.address, max);

        await expect(tokenSwap.connect(user).quickToQuickX(largest.add(1)))
          .to.be.revertedWith('panic code 0x11');
        expect(await quick.balanceOf(DEAD)).to.eq(0);
        expect(await quick.balanceOf(user.address)).to.eq(max);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(max);

        await expect(tokenSwap.connect(user).quickToQuickX(largest))
          .to.emit(tokenSwap, 'QuickToQuickX').withArgs(largest, largest.mul(ratio), user.address);
        expect(await quickX.balanceOf(user.address)).to.eq(largest.mul(ratio));
        expect(await quick.balanceOf(DEAD)).to.eq(largest);
      });

      it('reverts and changes no balance when the converter cannot pay', async function () {
        const funding = expandTo18Decimals(100).mul(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: expandTo18Decimals(1000), quickXSupply: funding, funding, userQuick: expandTo18Decimals(1000),
        });
        const amount = expandTo18Decimals(100).add(1);
        const holders = [user.address, tokenSwap.address, DEAD];
        const before = await balances([quick, quickX], holders);

        await quick.connect(user).approve(tokenSwap.address, amount);
        await expect(tokenSwap.connect(user).quickToQuickX(amount))
          .to.be.revertedWith('ERC20: transfer amount exceeds balance');

        expect(await balances([quick, quickX], holders)).to.deep.eq(before);
        expect(await quick.allowance(user.address, tokenSwap.address)).to.eq(amount);
      });

      it('reverts without an allowance and changes no balance', async function () {
        const funding = expandTo18Decimals(100).mul(ratio);
        const { quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: expandTo18Decimals(100), quickXSupply: funding, funding, userQuick: expandTo18Decimals(100),
        });
        const holders = [user.address, tokenSwap.address, DEAD];
        const before = await balances([quick, quickX], holders);

        await expect(tokenSwap.connect(user).quickToQuickX(expandTo18Decimals(1)))
          .to.be.revertedWith('ERC20: insufficient allowance');

        expect(await balances([quick, quickX], holders)).to.deep.eq(before);
      });
    });

    describe('withdrawTokens', function () {
      let quick;
      let quickX;
      let tokenSwap;
      const funding = expandTo18Decimals(10);

      beforeEach(async function () {
        ({ quick, quickX, tokenSwap } = await deploySystem({
          quickSupply: expandTo18Decimals(100), quickXSupply: funding, funding, userQuick: expandTo18Decimals(50),
        }));
      });

      it('rejects new QUICK withdrawals up to and including the timeout block, then allows them', async function () {
        const timeout = (await tokenSwap.withdrawTimeout()).toNumber();

        // The next transaction is mined in block `timeout`.
        await mineUntil(timeout - 1);
        await expect(tokenSwap.withdrawTokens(quickX.address, funding, MINED))
          .to.be.revertedWith('TokenSwap::withdrawTokens: TIMEOUT_NOT_REACHED');
        expect(await latestBlock()).to.eq(timeout);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(funding);

        // The next transaction is mined in block `timeout + 1`.
        await expect(tokenSwap.withdrawTokens(quickX.address, funding, MINED))
          .to.emit(quickX, 'Transfer').withArgs(tokenSwap.address, wallet.address, funding)
          .to.emit(tokenSwap, 'WithdrawTokens').withArgs(quickX.address, funding);
        expect(await latestBlock()).to.eq(timeout + 1);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(0);
        expect(await quickX.balanceOf(wallet.address)).to.eq(funding);
      });

      it('rejects new QUICK withdrawals well before the timeout', async function () {
        await expect(tokenSwap.withdrawTokens(quickX.address, 1))
          .to.be.revertedWith('TokenSwap::withdrawTokens: TIMEOUT_NOT_REACHED');
      });

      it('lets the owner withdraw old QUICK sent directly at any time', async function () {
        const amount = expandTo18Decimals(3);
        await quick.connect(user).transfer(tokenSwap.address, amount);
        const ownerBefore = await quick.balanceOf(wallet.address);

        expect(await latestBlock()).to.be.lt((await tokenSwap.withdrawTimeout()).toNumber());
        await expect(tokenSwap.withdrawTokens(quick.address, amount))
          .to.emit(quick, 'Transfer').withArgs(tokenSwap.address, wallet.address, amount)
          .to.emit(tokenSwap, 'WithdrawTokens').withArgs(quick.address, amount);
        expect(await quick.balanceOf(tokenSwap.address)).to.eq(0);
        expect(await quick.balanceOf(wallet.address)).to.eq(ownerBefore.add(amount));
      });

      it('lets the owner withdraw any third token at any time', async function () {
        const third = await TestToken.deploy('Third', 'THIRD', expandTo18Decimals(5));
        await third.transfer(tokenSwap.address, expandTo18Decimals(5));

        await expect(tokenSwap.withdrawTokens(third.address, expandTo18Decimals(2)))
          .to.emit(tokenSwap, 'WithdrawTokens').withArgs(third.address, expandTo18Decimals(2));
        expect(await third.balanceOf(wallet.address)).to.eq(expandTo18Decimals(2));
        expect(await third.balanceOf(tokenSwap.address)).to.eq(expandTo18Decimals(3));
      });

      it('rejects callers other than the owner, before and after the timeout', async function () {
        await quick.connect(user).transfer(tokenSwap.address, 1);
        await expect(tokenSwap.connect(other).withdrawTokens(quick.address, 1))
          .to.be.revertedWith('Ownable: caller is not the owner');

        await mineBlocks(DURATION + 1);
        await expect(tokenSwap.connect(other).withdrawTokens(quickX.address, funding))
          .to.be.revertedWith('Ownable: caller is not the owner');
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(funding);
      });
    });

    describe('setWithdrawTimeout', function () {
      let tokenSwap;

      beforeEach(async function () {
        ({ tokenSwap } = await deploySystem({ quickSupply: 1, quickXSupply: 1, funding: 0, userQuick: 0 }));
      });

      it('rejects an equal or lower timeout', async function () {
        const current = await tokenSwap.withdrawTimeout();
        await expect(tokenSwap.setWithdrawTimeout(current))
          .to.be.revertedWith('TokenSwap::setWithdrawTimeout: NEW_TIMEOUT_MUST_BE_HIGHER');
        await expect(tokenSwap.setWithdrawTimeout(current.sub(1)))
          .to.be.revertedWith('TokenSwap::setWithdrawTimeout: NEW_TIMEOUT_MUST_BE_HIGHER');
        expect(await tokenSwap.withdrawTimeout()).to.eq(current);
      });

      it('accepts a higher timeout and emits NewWithdrawTimeout', async function () {
        const next = (await tokenSwap.withdrawTimeout()).add(1);
        await expect(tokenSwap.setWithdrawTimeout(next))
          .to.emit(tokenSwap, 'NewWithdrawTimeout').withArgs(next);
        expect(await tokenSwap.withdrawTimeout()).to.eq(next);
      });

      it('rejects callers other than the owner', async function () {
        const next = (await tokenSwap.withdrawTimeout()).add(100);
        await expect(tokenSwap.connect(other).setWithdrawTimeout(next))
          .to.be.revertedWith('Ownable: caller is not the owner');
      });
    });

    describe('ownership handoff to the Safe', function () {
      afterEach(async function () {
        await ethers.provider.send('hardhat_stopImpersonatingAccount', [SAFE]);
      });

      it('moves every owner right to the Safe', async function () {
        const funding = expandTo18Decimals(10);
        const { quickX, tokenSwap } = await deploySystem({
          quickSupply: 1, quickXSupply: funding, funding, userQuick: 0,
        });

        await expect(tokenSwap.transferOwnership(SAFE))
          .to.emit(tokenSwap, 'OwnershipTransferred').withArgs(wallet.address, SAFE);
        expect(await tokenSwap.owner()).to.eq(SAFE);

        const next = (await tokenSwap.withdrawTimeout()).add(50);
        await expect(tokenSwap.setWithdrawTimeout(next))
          .to.be.revertedWith('Ownable: caller is not the owner');
        await mineBlocks(DURATION + 1);
        await expect(tokenSwap.withdrawTokens(quickX.address, funding))
          .to.be.revertedWith('Ownable: caller is not the owner');

        await ethers.provider.send('hardhat_impersonateAccount', [SAFE]);
        await ethers.provider.send('hardhat_setBalance', [SAFE, '0x8AC7230489E80000']);
        const safe = await ethers.getSigner(SAFE);

        await expect(tokenSwap.connect(safe).setWithdrawTimeout(next))
          .to.emit(tokenSwap, 'NewWithdrawTimeout').withArgs(next);
        await mineUntil(next.toNumber());
        await expect(tokenSwap.connect(safe).withdrawTokens(quickX.address, funding))
          .to.emit(quickX, 'Transfer').withArgs(tokenSwap.address, SAFE, funding)
          .to.emit(tokenSwap, 'WithdrawTokens').withArgs(quickX.address, funding);
        expect(await quickX.balanceOf(SAFE)).to.eq(funding);
        expect(await quickX.balanceOf(tokenSwap.address)).to.eq(0);
      });
    });

    describe('token callbacks during a swap', function () {
      const funding = expandTo18Decimals(1000).mul(ratio);
      const outer = expandTo18Decimals(10);
      const inner = expandTo18Decimals(4);

      // Checks that new QUICK paid out equals ratio * old QUICK sent to DEAD
      // and that only the listed recipients received new QUICK.
      async function expectPaidOut(quick, quickX, tokenSwap, recipients, oldQuickSwapped) {
        const paidOut = funding.sub(await quickX.balanceOf(tokenSwap.address));
        let received = BigNumber.from(0);
        for (const recipient of recipients) {
          received = received.add(await quickX.balanceOf(recipient));
        }
        expect(await quick.balanceOf(DEAD)).to.eq(oldQuickSwapped);
        expect(paidOut).to.eq(oldQuickSwapped.mul(ratio));
        expect(received).to.eq(paidOut);
        expect(await quick.balanceOf(tokenSwap.address)).to.eq(0);
      }

      it('keeps exact accounting when new QUICK calls back into quickToQuickX', async function () {
        const quick = await TestToken.deploy('QuickSwap', 'QUICK', expandTo18Decimals(100));
        const quickX = await CallbackToken.deploy(funding);
        const tokenSwap = await TokenSwap.deploy(quick.address, quickX.address, DURATION);
        await quickX.transfer(tokenSwap.address, funding);
        await quick.transfer(user.address, outer);
        await quick.transfer(quickX.address, inner);
        await quickX.execute(quick.address, quick.interface.encodeFunctionData('approve', [tokenSwap.address, inner]));
        await quickX.armHook(tokenSwap.address, tokenSwap.interface.encodeFunctionData('quickToQuickX', [inner]));

        await quick.connect(user).approve(tokenSwap.address, outer);
        await expect(tokenSwap.connect(user).quickToQuickX(outer))
          .to.emit(tokenSwap, 'QuickToQuickX').withArgs(inner, inner.mul(ratio), quickX.address)
          .to.emit(tokenSwap, 'QuickToQuickX').withArgs(outer, outer.mul(ratio), user.address);

        expect(await quickX.hookCalls()).to.eq(1);
        expect(await quickX.balanceOf(user.address)).to.eq(outer.mul(ratio));
        expect(await quickX.balanceOf(quickX.address)).to.eq(inner.mul(ratio));
        await expectPaidOut(quick, quickX, tokenSwap, [user.address, quickX.address], outer.add(inner));
      });

      it('keeps exact accounting when old QUICK calls back into quickToQuickX', async function () {
        const quick = await CallbackToken.deploy(expandTo18Decimals(100));
        const quickX = await TestToken.deploy('QuickSwap', 'QUICK-X', funding);
        const tokenSwap = await TokenSwap.deploy(quick.address, quickX.address, DURATION);
        await quickX.transfer(tokenSwap.address, funding);
        await quick.transfer(user.address, outer);
        await quick.transfer(quick.address, inner);
        await quick.execute(quick.address, quick.interface.encodeFunctionData('approve', [tokenSwap.address, inner]));
        await quick.armHook(tokenSwap.address, tokenSwap.interface.encodeFunctionData('quickToQuickX', [inner]));

        await quick.connect(user).approve(tokenSwap.address, outer);
        await tokenSwap.connect(user).quickToQuickX(outer);

        expect(await quick.hookCalls()).to.eq(1);
        expect(await quickX.balanceOf(user.address)).to.eq(outer.mul(ratio));
        expect(await quickX.balanceOf(quick.address)).to.eq(inner.mul(ratio));
        await expectPaidOut(quick, quickX, tokenSwap, [user.address, quick.address], outer.add(inner));
      });

      it('reverts the whole swap when new QUICK calls back into withdrawTokens', async function () {
        const quick = await TestToken.deploy('QuickSwap', 'QUICK', expandTo18Decimals(100));
        const quickX = await CallbackToken.deploy(funding);
        const tokenSwap = await TokenSwap.deploy(quick.address, quickX.address, DURATION);
        await quickX.transfer(tokenSwap.address, funding);
        await quick.transfer(user.address, outer);
        await mineBlocks(DURATION + 1);
        await quickX.armHook(
          tokenSwap.address,
          tokenSwap.interface.encodeFunctionData('withdrawTokens', [quickX.address, funding.sub(outer.mul(ratio))]),
        );

        const holders = [user.address, tokenSwap.address, quickX.address, DEAD, wallet.address];
        const before = await balances([quick, quickX], holders);
        await quick.connect(user).approve(tokenSwap.address, outer);
        await expect(tokenSwap.connect(user).quickToQuickX(outer))
          .to.be.revertedWith('Ownable: caller is not the owner');

        expect(await balances([quick, quickX], holders)).to.deep.eq(before);
        expect(await quickX.hookArmed()).to.eq(true);
        expect(await quickX.hookCalls()).to.eq(0);
        await expectPaidOut(quick, quickX, tokenSwap, [], BigNumber.from(0));
      });
    });
  });
}
