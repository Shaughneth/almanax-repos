import { ethers } from 'hardhat'
import { BigNumber, BigNumberish, constants, Wallet } from 'ethers'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { TestERC20 } from '../typechain/test/TestERC20'
import { AlgebraFactory } from '../typechain/AlgebraFactory'
import { MockTimeAlgebraPool } from '../typechain/test/MockTimeAlgebraPool'
import { MockTimeVirtualPool } from '../typechain/test/MockTimeVirtualPool'
import { TestAlgebraSwapPay } from '../typechain/test/TestAlgebraSwapPay'
import checkTimepointEquals from './shared/checkTimepointEquals'
import { expect } from './shared/expect'

import { poolFixture, TEST_POOL_START_TIME} from './shared/fixtures'

import {
  expandTo18Decimals,
  FeeAmount,
  getPositionKey,
  getMaxTick,
  getMinTick,
  encodePriceSqrt,
  TICK_SPACINGS,
  createPoolFunctions,
  SwapFunction,
  MintFunction,
  FlashFunction,
  MaxUint128,
  MAX_SQRT_RATIO,
  MIN_SQRT_RATIO,
  SwapToPriceFunction,
  AddLimitFunction,
  MIN_TICK,
  MAX_TICK,
} from './shared/utilities'
import { TestAlgebraCallee } from '../typechain/test/TestAlgebraCallee'
import { TestAlgebraReentrantCallee } from '../typechain/test/TestAlgebraReentrantCallee'
import { TickMathTest } from '../typechain/test/TickMathTest'
import { PriceMovementMathTest } from '../typechain/test/PriceMovementMathTest'
import { MockTimeDataStorageOperator } from '../typechain/test/MockTimeDataStorageOperator';


type ThenArg<T> = T extends PromiseLike<infer U> ? U : T

describe('AlgebraPool', () => {
  let wallet: Wallet, other: Wallet

  let token0: TestERC20
  let token1: TestERC20
  let token2: TestERC20

  let factory: AlgebraFactory
  let pool: MockTimeAlgebraPool
  let dsOperator: MockTimeDataStorageOperator

  let swapTarget: TestAlgebraCallee

  let swapToLowerPrice: SwapToPriceFunction
  let swapToHigherPrice: SwapToPriceFunction
  let swapExact0For1SupportingFee: SwapFunction
  let swapExact1For0SupportingFee: SwapFunction
  let swapExact0For1: SwapFunction
  let swap0ForExact1: SwapFunction
  let swapExact1For0: SwapFunction
  let swap1ForExact0: SwapFunction

  let tickSpacing: number

  let minTick: number
  let maxTick: number

  let mint: MintFunction
  let flash: FlashFunction
  let addLimitOrder: AddLimitFunction

  let createPoolWrapped: ThenArg<ReturnType<typeof poolFixture>>['createPool']

  let vaultAddress: string;

  beforeEach('deploy fixture', async () => {
    ;[wallet, other] = await (ethers as any).getSigners()
    let vault;
    let _createPool: ThenArg<ReturnType<typeof poolFixture>>['createPool'];
    ;({ token0, token1, token2, factory, vault, createPool:_createPool, swapTargetCallee: swapTarget } = await loadFixture(poolFixture))
    vaultAddress = vault.address;
    createPoolWrapped = async () => {
      const pool = await _createPool()
      ;({
        swapToLowerPrice,
        swapToHigherPrice,
        swapExact0For1,
        swapExact0For1SupportingFee,
        swap0ForExact1,
        swapExact1For0,
        swapExact1For0SupportingFee,
        swap1ForExact0,
        mint,
        flash,
        addLimitOrder
      } = createPoolFunctions({
        token0,
        token1,
        swapTarget,
        pool,
      }))
      minTick = getMinTick(60)
      maxTick = getMaxTick(60)
      tickSpacing = 60
      return pool
    }
    pool = await createPoolWrapped()
    const dsOperatorFactory = await ethers.getContractFactory('MockTimeDataStorageOperator')
    dsOperator = (dsOperatorFactory.attach(await pool.dataStorageOperator())) as MockTimeDataStorageOperator;
  })

  it('constructor initializes immutables', async () => {
    expect(await pool.factory()).to.eq(factory.address)
    expect(await pool.token0()).to.eq(token0.address)
    expect(await pool.token1()).to.eq(token1.address)
    expect(await pool.maxLiquidityPerTick()).to.eq(BigNumber.from("40564824043007195767232224305152"))
  })

  it('_blockTimestamp works', async() => {
    expect(await pool.checkBlockTimestamp()).to.be.eq(true);
  })

  describe('#initialize', () => {
    it('fails if already initialized', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await expect(pool.initialize(encodePriceSqrt(1, 1))).to.be.reverted
    })
    it('fails if starting price is too low', async () => {
      await expect(pool.initialize(1)).to.be.revertedWithCustomError(pool, 'priceOutOfRange')
      await expect(pool.initialize(MIN_SQRT_RATIO.sub(1))).to.be.revertedWithCustomError(pool, 'priceOutOfRange')
    })
    it('fails if starting price is too high', async () => {
      await expect(pool.initialize(MAX_SQRT_RATIO)).to.be.revertedWithCustomError(pool, 'priceOutOfRange')
      await expect(pool.initialize(BigNumber.from(2).pow(160).sub(1))).to.be.revertedWithCustomError(pool, 'priceOutOfRange')
    })
    it('can be initialized at MIN_SQRT_RATIO', async () => {
      await pool.initialize(MIN_SQRT_RATIO)
      expect((await pool.globalState()).tick).to.eq(getMinTick(1))
    })
    it('can be initialized at MAX_SQRT_RATIO - 1', async () => {
      await pool.initialize(MAX_SQRT_RATIO.sub(1))
      expect((await pool.globalState()).tick).to.eq(getMaxTick(1) - 1)
    })
    it('sets initial variables', async () => {
      const initPrice = encodePriceSqrt(1, 2)
      await pool.initialize(initPrice)

      const { price, timepointIndex } = await pool.globalState()
      expect(price).to.eq(price)
      expect(timepointIndex).to.eq(0)
      expect((await pool.globalState()).tick).to.eq(-6932)
    })
    it('initializes timepoints slot', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      checkTimepointEquals(await dsOperator.timepoints(0), {
        initialized: true,
        blockTimestamp: TEST_POOL_START_TIME,
        tickCumulative: 0,
      })
    })
    it('emits a Initialized event with the input tick', async () => {
      const price = encodePriceSqrt(1, 2)
      await expect(pool.initialize(price)).to.emit(pool, 'Initialize').withArgs(price, -6932)
    })
  })

  describe('#mint', () => {
    it('fails if not initialized', async () => {
      await expect(mint(wallet.address, -tickSpacing, tickSpacing, 1)).to.be.revertedWithCustomError(pool, 'locked')
    })
    describe('after initialization', () => {
      beforeEach('initialize the pool at price of 10:1', async () => {
        await pool.initialize(encodePriceSqrt(1, 10))
        await mint(wallet.address, minTick, maxTick, 3161)
      })

      describe('failure cases', () => {
        describe('underpayment', () => {
          let payer: TestAlgebraSwapPay;

          beforeEach(async() => {
            const factory = await ethers.getContractFactory('TestAlgebraSwapPay')
            payer = (await factory.deploy()) as TestAlgebraSwapPay;
            await token0.approve(payer.address, BigNumber.from(2).pow(256).sub(1));
            await token1.approve(payer.address, BigNumber.from(2).pow(256).sub(1));
          })

          it('fails if token0 payed 0', async() => {
            await expect(payer.mint(pool.address, wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100, 0, 100)).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
            await expect(payer.mint(pool.address, wallet.address, -22980, 0, 10000, 0, 100)).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
          }) 

          it('fails if token1 payed 0', async() => {
            await expect(payer.mint(pool.address, wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100, 100, 0)).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
            await expect(payer.mint(pool.address, wallet.address, minTick + tickSpacing, Math.floor((-23028 - tickSpacing) / tickSpacing)*tickSpacing, 10000, 100, 0)).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
          }) 

          it('fails if token0 hardly underpayed', async() => {
            await expect(payer.mint(pool.address, wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100, 1, expandTo18Decimals(100))).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
          })     

          it('fails if token1 hardly underpayed', async() => {
            await swapToHigherPrice(encodePriceSqrt(10, 1), wallet.address);
            await expect(payer.mint(pool.address, wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100, expandTo18Decimals(100), 1)).to.be.revertedWithCustomError(pool, 'zeroLiquidityActual');
          })          
        })


        it('fails if bottomTick greater than topTick', async () => {
          // should be TLU but...hardhat
          await expect(mint(wallet.address, 1, 0, 1)).to.be.reverted
        })
        it('fails if bottomTick less than min tick', async () => {
          // should be TLM but...hardhat
          await expect(mint(wallet.address, -887273, 0, 1)).to.be.reverted
        })
        it('fails if topTick greater than max tick', async () => {
          // should be TUM but...hardhat
          await expect(mint(wallet.address, 0, 887273, 1)).to.be.reverted
        })
        it('fails if amount exceeds the max', async () => {
          // these should fail with 'liquidityOverflow' but hardhat is bugged
          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.add(1))).to
            .be.revertedWithCustomError(pool, 'liquidityOverflow');
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross)).to.not.be
            .reverted
        })
        it('fails if total amount at tick exceeds the max', async () => {
          // these should fail with 'liquidityOverflow' but hardhat is bugged
          await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1000)

          const maxLiquidityGross = await pool.maxLiquidityPerTick()
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.sub(1000).add(1))
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing * 2, maxTick - tickSpacing, maxLiquidityGross.sub(1000).add(1))
          ).to.be.reverted
          await expect(
            mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing * 2, maxLiquidityGross.sub(1000).add(1))
          ).to.be.reverted
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, maxLiquidityGross.sub(1000)))
            .to.not.be.reverted
        })
        it('fails if amount is 0', async () => {
          await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 0)).to.be.revertedWithCustomError(pool, 'zeroLiquidityDesired');
        })
      })

      describe('success cases', () => {
        it('initial balances', async () => {
          expect(await token0.balanceOf(pool.address)).to.eq(9996)
          expect(await token1.balanceOf(pool.address)).to.eq(1000)
        })

        it('initial tick', async () => {
          expect((await pool.globalState()).tick).to.eq(-23028)
        })

        describe('above current price', () => {
          it('transfers token0 only', async () => {
            await expect(mint(wallet.address, -22980, 0, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.address, 21549)
              .to.not.emit(token1, 'Transfer')
            expect(await token0.balanceOf(pool.address)).to.eq(9996 + 21549)
            expect(await token1.balanceOf(pool.address)).to.eq(1000)
          })

          it('max tick with max leverage', async () => {
            await mint(wallet.address, maxTick - tickSpacing, maxTick, BigNumber.from(2).pow(102))
            expect(await token0.balanceOf(pool.address)).to.eq(9996 + 828011525)
            expect(await token1.balanceOf(pool.address)).to.eq(1000)
          })

          it('works for max tick', async () => {
            await expect(mint(wallet.address, -22980, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.address, 31549)
            expect(await token0.balanceOf(pool.address)).to.eq(9996 + 31549)
            expect(await token1.balanceOf(pool.address)).to.eq(1000)
          })

          it('removing works', async () => {
            await mint(wallet.address, -240, 0, 10000)
            await pool.burn(-240, 0, 10000)
            const { amount0, amount1 } = await pool.callStatic.collect(wallet.address, -240, 0, MaxUint128, MaxUint128)
            expect(amount0, 'amount0').to.eq(120)
            expect(amount1, 'amount1').to.eq(0)
          })

          it('adds liquidity to liquidityTotal', async () => {
            await mint(wallet.address, -240, 0, 100)
            expect((await pool.ticks(-240)).liquidityTotal).to.eq(100)
            expect((await pool.ticks(0)).liquidityTotal).to.eq(100)
            expect((await pool.ticks(tickSpacing)).liquidityTotal).to.eq(0)
            expect((await pool.ticks(tickSpacing * 2)).liquidityTotal).to.eq(0)
            await mint(wallet.address, -240, tickSpacing, 150)
            expect((await pool.ticks(-240)).liquidityTotal).to.eq(250)
            expect((await pool.ticks(0)).liquidityTotal).to.eq(100)
            expect((await pool.ticks(tickSpacing)).liquidityTotal).to.eq(150)
            expect((await pool.ticks(tickSpacing * 2)).liquidityTotal).to.eq(0)
            await mint(wallet.address, 0, tickSpacing * 2, 60)
            expect((await pool.ticks(-240)).liquidityTotal).to.eq(250)
            expect((await pool.ticks(0)).liquidityTotal).to.eq(160)
            expect((await pool.ticks(tickSpacing)).liquidityTotal).to.eq(150)
            expect((await pool.ticks(tickSpacing * 2)).liquidityTotal).to.eq(60)
          })

          it('removes liquidity from liquidityTotal', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -240, 0, 40)
            await pool.burn(-240, 0, 90)
            expect((await pool.ticks(-240)).liquidityTotal).to.eq(50)
            expect((await pool.ticks(0)).liquidityTotal).to.eq(50)
          })

          it('clears tick lower if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pool.burn(-240, 0, 100)
            const { liquidityTotal, outerFeeGrowth0Token, outerFeeGrowth1Token } = await pool.ticks(-240)
            expect(liquidityTotal).to.eq(0)
            expect(outerFeeGrowth0Token).to.eq(0)
            expect(outerFeeGrowth1Token).to.eq(0)
          })

          it('clears tick upper if last position is removed', async () => {
            await mint(wallet.address, -240, 0, 100)
            await pool.burn(-240, 0, 100)
            const { liquidityTotal, outerFeeGrowth0Token, outerFeeGrowth1Token } = await pool.ticks(0)
            expect(liquidityTotal).to.eq(0)
            expect(outerFeeGrowth0Token).to.eq(0)
            expect(outerFeeGrowth1Token).to.eq(0)
          })
          it('only clears the tick that is not used at all', async () => {
            await mint(wallet.address, -240, 0, 100)
            await mint(wallet.address, -tickSpacing, 0, 250)
            await pool.burn(-240, 0, 100)

            let { liquidityTotal, outerFeeGrowth0Token, outerFeeGrowth1Token } = await pool.ticks(-240)
            expect(liquidityTotal).to.eq(0)
            expect(outerFeeGrowth0Token).to.eq(0)
            expect(outerFeeGrowth1Token).to.eq(0)
            ;({ liquidityTotal, outerFeeGrowth0Token, outerFeeGrowth1Token } = await pool.ticks(-tickSpacing))
            expect(liquidityTotal).to.eq(250)
            expect(outerFeeGrowth0Token).to.eq(0)
            expect(outerFeeGrowth1Token).to.eq(0)
          })

          it('does not write an timepoint', async () => {
            checkTimepointEquals(await dsOperator.timepoints(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, -240, 0, 100)
            checkTimepointEquals(await dsOperator.timepoints(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
            })
          })
        })

        describe('including current price', () => {
          it('price within range: transfers current price of both tokens', async () => {
            await expect(mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.address, 317)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.address, 32)
            expect(await token0.balanceOf(pool.address)).to.eq(9996 + 317)
            expect(await token1.balanceOf(pool.address)).to.eq(1000 + 32)
          })

          it('initializes lower tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityTotal } = await pool.ticks(minTick + tickSpacing)
            expect(liquidityTotal).to.eq(100)
          })

          it('initializes upper tick', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { liquidityTotal } = await pool.ticks(maxTick - tickSpacing)
            expect(liquidityTotal).to.eq(100)
          })

          it('works for min/max tick', async () => {
            await expect(mint(wallet.address, minTick, maxTick, 10000))
              .to.emit(token0, 'Transfer')
              .withArgs(wallet.address, pool.address, 31623)
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.address, 3163)
            expect(await token0.balanceOf(pool.address)).to.eq(9996 + 31623)
            expect(await token1.balanceOf(pool.address)).to.eq(1000 + 3163)
          })

          it('removing works', async () => {
            await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 100)
            await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 100)
            const { amount0, amount1 } = await pool.callStatic.collect(
              wallet.address,
              minTick + tickSpacing,
              maxTick - tickSpacing,
              MaxUint128,
              MaxUint128
            )
            expect(amount0, 'amount0').to.eq(316)
            expect(amount1, 'amount1').to.eq(31)
          })

          it('writes an timepoint', async () => {
            checkTimepointEquals(await dsOperator.timepoints(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
            })
            await pool.advanceTime(1)
            await mint(wallet.address, minTick, maxTick, 100)
            checkTimepointEquals(await dsOperator.timepoints(1), {
              tickCumulative: -23028,
              blockTimestamp: TEST_POOL_START_TIME + 1,
              initialized: true,
            })
            expect(await pool.secondsPerLiquidityCumulative()).to.be.eq('107650226801941937191829992860413859');
          })
        })

        describe('below current price', () => {
          it('transfers token1 only', async () => {
            await expect(mint(wallet.address, -46080, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.address, 2162)
              .to.not.emit(token0, 'Transfer')
            expect(await token0.balanceOf(pool.address)).to.eq(9996)
            expect(await token1.balanceOf(pool.address)).to.eq(1000 + 2162)
          })

          it('min tick with max leverage', async () => {
            await mint(wallet.address, minTick, minTick + tickSpacing, BigNumber.from(2).pow(102))
            expect(await token0.balanceOf(pool.address)).to.eq(9996)
            expect(await token1.balanceOf(pool.address)).to.eq(1000 + 828011520)
          })

          it('works for min tick', async () => {
            await expect(mint(wallet.address, minTick, -23040, 10000))
              .to.emit(token1, 'Transfer')
              .withArgs(wallet.address, pool.address, 3161)
            expect(await token0.balanceOf(pool.address)).to.eq(9996)
            expect(await token1.balanceOf(pool.address)).to.eq(1000 + 3161)
          })

          it('removing works', async () => {
            await mint(wallet.address, -46080, -46020, 10000)
            await pool.burn(-46080, -46020, 10000)
            const { amount0, amount1 } = await pool.callStatic.collect(
              wallet.address,
              -46080,
              -46020,
              MaxUint128,
              MaxUint128
            )
            expect(amount0, 'amount0').to.eq(0)
            expect(amount1, 'amount1').to.eq(3)
          })

          it('does not write an timepoint', async () => {
            checkTimepointEquals(await dsOperator.timepoints(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true
            })
            expect(await pool.secondsPerLiquidityCumulative()).to.be.eq(0);
            await pool.advanceTime(1)
            await mint(wallet.address, -46080, -23040, 100)
            checkTimepointEquals(await dsOperator.timepoints(0), {
              tickCumulative: 0,
              blockTimestamp: TEST_POOL_START_TIME,
              initialized: true,
            })
            expect(await pool.secondsPerLiquidityCumulative()).to.be.eq(0);
          })
        })
      })

      it('community fees accumulate as expected during swap', async () => {
        await pool.setCommunityFee(170)

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        expect((await token0.balanceOf(vaultAddress)).toString()).to.eq('1700000000000')
        const [,communityFeePending1] = await pool.getCommunityFeePending();
        expect((communityFeePending1).toString()).to.eq('170000000000')
      })

      it('positions are protected before community fee is turned on', async () => {
        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        expect(Number((await token0.balanceOf(vaultAddress)).toString())).to.eq(0)
        expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(0)

        await pool.setCommunityFee(170)
        expect(Number((await token0.balanceOf(vaultAddress)).toString())).to.eq(0)
        expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(0)
      })

      it('poke is not happened on uninitialized position', async () => {
        await mint(other.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1).div(10), wallet.address)
        await swapExact1For0(expandTo18Decimals(1).div(100), wallet.address)

        await expect(pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0)).to.be.not.reverted
        let {
          liquidity: l0,
          innerFeeGrowth0Token: ifg0,
          innerFeeGrowth1Token: ifg1,
          fees1: f1,
          fees0: f0,
        } = await pool.positions(await pool.getKeyForPosition(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))

        expect(l0).to.eq(0)
        expect(f0, 'tokens owed 0 before np').to.eq(0)
        expect(f1, 'tokens owed 1 before np').to.eq(0)
        expect(ifg0).to.eq('0')
        expect(ifg1).to.eq('0')

        await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, 1)
        let {
          liquidity,
          innerFeeGrowth0Token,
          innerFeeGrowth1Token,
          fees1,
          fees0,
        } = await pool.positions(await pool.getKeyForPosition(wallet.address, minTick + tickSpacing, maxTick - tickSpacing))
        expect(liquidity).to.eq(1)
        expect(fees0, 'tokens owed 0 before').to.eq(0)
        expect(fees1, 'tokens owed 1 before').to.eq(0)
        expect(innerFeeGrowth0Token).to.eq('3402823669209373878308127703486852')
        expect(innerFeeGrowth1Token).to.eq('340282366920937387830812770348685')

        await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 1)
        ;({
          liquidity,
          innerFeeGrowth0Token,
          innerFeeGrowth1Token,
          fees1,
          fees0,
        } = await pool.positions(await pool.getKeyForPosition(wallet.address, minTick + tickSpacing, maxTick - tickSpacing)))
        expect(liquidity).to.eq(0)
        expect(innerFeeGrowth0Token).to.eq('3402823669209373878308127703486852')
        expect(innerFeeGrowth1Token).to.eq('340282366920937387830812770348685')
        expect(fees0, 'tokens owed 0 after').to.eq(3)
        expect(fees1, 'tokens owed 1 after').to.eq(0)
      })
    })
  })

  describe('#burn', () => {
    beforeEach('initialize at zero tick', () => initializeAtZeroTick(pool))

    async function checkTickIsClear(tick: number) {
      const { liquidityTotal, outerFeeGrowth0Token, outerFeeGrowth1Token, liquidityDelta } = await pool.ticks(tick)
      expect(liquidityTotal).to.eq(0)
      expect(outerFeeGrowth0Token).to.eq(0)
      expect(outerFeeGrowth1Token).to.eq(0)
      expect(liquidityDelta).to.eq(0)
    }

    async function checkTickIsNotClear(tick: number) {
      const { liquidityTotal } = await pool.ticks(tick)
      expect(liquidityTotal).to.not.eq(0)
    }

    it('does not clear the position fee growth snapshot if no more liquidity', async () => {
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10)
      await mint(other.address, minTick, maxTick, expandTo18Decimals(1))
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await swapExact1For0(expandTo18Decimals(1), wallet.address)
      await pool.connect(other).burn(minTick, maxTick, expandTo18Decimals(1))
      const {
        liquidity,
        fees0,
        fees1,
        innerFeeGrowth0Token,
        innerFeeGrowth1Token,
      } = await pool.positions(await pool.getKeyForPosition(other.address, minTick, maxTick))
      expect(liquidity).to.eq(0)
      expect(fees0).to.not.eq(0)
      expect(fees1).to.not.eq(0)
      expect(innerFeeGrowth0Token).to.eq('11342745564031282115445820247725607')
      expect(innerFeeGrowth1Token).to.eq('11342745564031282115445820247725607')
    })

    it('clears the tick if its the last position using it', async () => {
      const bottomTick = minTick + tickSpacing
      const topTick = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10)
      await mint(wallet.address, bottomTick, topTick, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(bottomTick, topTick, 1)
      await checkTickIsClear(bottomTick)
      await checkTickIsClear(topTick)
    })

    it('clears only the lower tick if upper is still used', async () => {
      const bottomTick = minTick + tickSpacing
      const topTick = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10)
      await mint(wallet.address, bottomTick, topTick, 1)
      await mint(wallet.address, bottomTick + tickSpacing, topTick, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(bottomTick, topTick, 1)
      await checkTickIsClear(bottomTick)
      await checkTickIsNotClear(topTick)
    })

    it('clears only the upper tick if lower is still used', async () => {
      const bottomTick = minTick + tickSpacing
      const topTick = maxTick - tickSpacing
      // some activity that would make the ticks non-zero
      await pool.advanceTime(10)
      await mint(wallet.address, bottomTick, topTick, 1)
      await mint(wallet.address, bottomTick, topTick - tickSpacing, 1)
      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      await pool.burn(bottomTick, topTick, 1)
      await checkTickIsNotClear(bottomTick)
      await checkTickIsClear(topTick)
    })

  })

  // the combined amount of liquidity that the pool is initialized with (including the 1 minimum liquidity that is burned)
  const initializeLiquidityAmount = expandTo18Decimals(2)
  async function initializeAtZeroTick(pool: MockTimeAlgebraPool): Promise<void> {
    await pool.initialize(encodePriceSqrt(1, 1))
    const tickSpacing = await pool.tickSpacing()
    const [min, max] = [getMinTick(tickSpacing), getMaxTick(tickSpacing)]
    await mint(wallet.address, min, max, initializeLiquidityAmount)
  }

  describe('#getTimepoints', () => {
    beforeEach(() => initializeAtZeroTick(pool))

    // zero tick
    it('current tick accumulator increases by tick over time', async () => {
      let {
        tickCumulatives: [tickCumulative],
      } = await dsOperator.getTimepoints([0])
      expect(tickCumulative).to.eq(0)
      await pool.advanceTime(10)
      ;({
        tickCumulatives: [tickCumulative],
      } = await dsOperator.getTimepoints([0]))
      expect(tickCumulative).to.eq(0)
    })

    it('current tick accumulator after single swap', async () => {
      // moves to tick -1
      await swapExact0For1(1000, wallet.address)
      await pool.advanceTime(4)
      await dsOperator.advanceTime(4);
      let {
        tickCumulatives: [tickCumulative],
      } = await dsOperator.getTimepoints([0])
      expect(tickCumulative).to.eq(-4)
    })

    it('current tick accumulator after swaps', async () => {
      await swapExact0For1(expandTo18Decimals(1).div(2), wallet.address);
      expect((await pool.globalState()).tick).to.eq(-4463);
      await pool.advanceTime(4);
      await dsOperator.advanceTime(4);
      await swapExact1For0(expandTo18Decimals(1).div(4), wallet.address);
      expect((await pool.globalState()).tick).to.eq(-1560);
      let {
        tickCumulatives: [tickCumulative0],
      } = await dsOperator.getTimepoints([0])
      expect(tickCumulative0).to.eq(-17852);
      await pool.advanceTime(60 * 5);
      await dsOperator.advanceTime(60 * 5);
      await swapExact0For1(100, wallet.address);
      let {
        tickCumulatives: [tickCumulative1],
      } = await dsOperator.getTimepoints([0]);
      expect(tickCumulative1).to.eq(-485852);
    })
  })

  describe('miscellaneous mint tests', () => {
    beforeEach('initialize at zero tick', async () => {
      pool = await createPoolWrapped()
      await initializeAtZeroTick(pool)
    })

    it('mint to the right of the current price', async () => {
      const liquidityDelta = 1000
      const bottomTick = tickSpacing
      const topTick = tickSpacing * 2

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.address)
      const b1 = await token1.balanceOf(pool.address)

      await mint(wallet.address, bottomTick, topTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.address)).sub(b0)).to.eq(3)
      expect((await token1.balanceOf(pool.address)).sub(b1)).to.eq(0)
    })

    it('mint to the left of the current price', async () => {
      const liquidityDelta = 1000
      const bottomTick = -tickSpacing * 2
      const topTick = -tickSpacing

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.address)
      const b1 = await token1.balanceOf(pool.address)

      await mint(wallet.address, bottomTick, topTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.address)).sub(b0)).to.eq(0)
      expect((await token1.balanceOf(pool.address)).sub(b1)).to.eq(3)
    })

    it('mint within the current price', async () => {
      const liquidityDelta = 1000
      const bottomTick = -tickSpacing
      const topTick = tickSpacing

      const liquidityBefore = await pool.liquidity()

      const b0 = await token0.balanceOf(pool.address)
      const b1 = await token1.balanceOf(pool.address)

      await mint(wallet.address, bottomTick, topTick, liquidityDelta)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter).to.be.gte(liquidityBefore)

      expect((await token0.balanceOf(pool.address)).sub(b0)).to.eq(3)
      expect((await token1.balanceOf(pool.address)).sub(b1)).to.eq(3)
    })

    it('cannot remove more than the entire position', async () => {
      const bottomTick = -tickSpacing
      const topTick = tickSpacing
      await mint(wallet.address, bottomTick, topTick, expandTo18Decimals(1000))
      await expect(pool.burn(bottomTick, topTick, expandTo18Decimals(1001))).to.be.revertedWithCustomError(pool, 'liquiditySub')
    })

    it('collect fees within the current price after swap', async () => {
      const liquidityDelta = expandTo18Decimals(100)
      const bottomTick = -tickSpacing * 100
      const topTick = tickSpacing * 100

      await mint(wallet.address, bottomTick, topTick, liquidityDelta)

      const liquidityBefore = await pool.liquidity()

      const amount0In = expandTo18Decimals(1)
      await swapExact0For1(amount0In, wallet.address)

      const liquidityAfter = await pool.liquidity()
      expect(liquidityAfter, 'k increases').to.be.gte(liquidityBefore)

      const token0BalanceBeforePool = await token0.balanceOf(pool.address)
      const token1BalanceBeforePool = await token1.balanceOf(pool.address)
      const token0BalanceBeforeWallet = await token0.balanceOf(wallet.address)
      const token1BalanceBeforeWallet = await token1.balanceOf(wallet.address)

      await pool.burn(bottomTick, topTick, 0)
      await pool.collect(wallet.address, bottomTick, topTick, MaxUint128, MaxUint128)

      await pool.burn(bottomTick, topTick, 0)
      const { amount0: fees0, amount1: fees1 } = await pool.callStatic.collect(
        wallet.address,
        bottomTick,
        topTick,
        MaxUint128,
        MaxUint128
      )
      expect(fees0).to.be.eq(0)
      expect(fees1).to.be.eq(0)

      const token0BalanceAfterWallet = await token0.balanceOf(wallet.address)
      const token1BalanceAfterWallet = await token1.balanceOf(wallet.address)
      const token0BalanceAfterPool = await token0.balanceOf(pool.address)
      const token1BalanceAfterPool = await token1.balanceOf(pool.address)

      expect(token0BalanceAfterWallet).to.be.gt(token0BalanceBeforeWallet)
      expect(token1BalanceAfterWallet).to.be.eq(token1BalanceBeforeWallet)

      expect(token0BalanceAfterPool).to.be.lt(token0BalanceBeforePool)
      expect(token1BalanceAfterPool).to.be.eq(token1BalanceBeforePool)
    })
  })

  describe('post-initialize at medium fee', () => {
    describe('k (implicit)', () => {
      it('returns 0 before initialization', async () => {
        expect(await pool.liquidity()).to.eq(0)
      })
      describe('post initialized', () => {
        beforeEach(() => initializeAtZeroTick(pool))

        it('returns initial liquidity', async () => {
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('returns in supply in range', async () => {
          await mint(wallet.address, -tickSpacing, tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(5))
        })
        it('excludes supply at tick above current tick', async () => {
          await mint(wallet.address, tickSpacing, tickSpacing * 2, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('excludes supply at tick below current tick', async () => {
          await mint(wallet.address, -tickSpacing * 2, -tickSpacing, expandTo18Decimals(3))
          expect(await pool.liquidity()).to.eq(expandTo18Decimals(2))
        })
        it('updates correctly when exiting range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity at and above current tick
          const liquidityDelta = expandTo18Decimals(1)
          const bottomTick = 0
          const topTick = tickSpacing
          await mint(wallet.address, bottomTick, topTick, liquidityDelta)

          // ensure virtual supply has increased appropriately
          const kAfter = await pool.liquidity()
          expect(kAfter).to.be.eq(expandTo18Decimals(3))

          // swap toward the left (just enough for the tick transition function to trigger)
          await swapExact0For1(1, wallet.address)
          const { tick } = await pool.globalState()
          expect(tick).to.be.eq(-1)

          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(2))
        })
        it('updates correctly when entering range', async () => {
          const kBefore = await pool.liquidity()
          expect(kBefore).to.be.eq(expandTo18Decimals(2))

          // add liquidity below the current tick
          const liquidityDelta = expandTo18Decimals(1)
          const bottomTick = -tickSpacing
          const topTick = 0
          await mint(wallet.address, bottomTick, topTick, liquidityDelta)

          // ensure virtual supply hasn't changed
          const kAfter = await pool.liquidity()
          expect(kAfter).to.be.eq(kBefore)

          // swap toward the left (just enough for the tick transition function to trigger)
          await swapExact0For1(1, wallet.address)
          const { tick } = await pool.globalState()
          expect(tick).to.be.eq(-1)

          const kAfterSwap = await pool.liquidity()
          expect(kAfterSwap).to.be.eq(expandTo18Decimals(3))
        })
      })
    })
  })

  describe('limit orders', () => {
    beforeEach('initialize at tick 0', () => initializeAtZeroTick(pool))

    it('limit selling 0 for 1 at tick 0 thru 1', async () => {
      await expect(mint(wallet.address, 0, 120, expandTo18Decimals(1)))
        .to.emit(token0, 'Transfer')
        .withArgs(wallet.address, pool.address, '5981737760509663')
      // somebody takes the limit order
      await swapExact1For0(expandTo18Decimals(2), other.address)
      await expect(pool.burn(0, 120, expandTo18Decimals(1)))
        .to.emit(pool, 'Burn')
        .withArgs(wallet.address, 0, 120, expandTo18Decimals(1), 0, '6017734268818165')
        .to.not.emit(token0, 'Transfer')
        .to.not.emit(token1, 'Transfer')
      await expect(pool.collect(wallet.address, 0, 120, MaxUint128, MaxUint128))
        .to.emit(token1, 'Transfer')
        .withArgs(pool.address, wallet.address, BigNumber.from('6018336102428407')) // roughly 0.3% despite other liquidity
        .to.not.emit(token0, 'Transfer')
      expect((await pool.globalState()).tick).to.be.gte(120)
    })
    it('limit selling 1 for 0 at tick 0 thru -1', async () => {
      await expect(mint(wallet.address, -120, 0, expandTo18Decimals(1)))
        .to.emit(token1, 'Transfer')
        .withArgs(wallet.address, pool.address, '5981737760509663')
      // somebody takes the limit order
      await swapExact0For1(expandTo18Decimals(2), other.address)
      await expect(pool.burn(-120, 0, expandTo18Decimals(1)))
        .to.emit(pool, 'Burn')
        .withArgs(wallet.address, -120, 0, expandTo18Decimals(1), '6017734268818165', 0)
        .to.not.emit(token0, 'Transfer')
        .to.not.emit(token1, 'Transfer')
      await expect(pool.collect(wallet.address, -120, 0, MaxUint128, MaxUint128))
        .to.emit(token0, 'Transfer')
        .withArgs(pool.address, wallet.address, BigNumber.from('6018336102428407')) // roughly 0.3% despite other liquidity
      expect((await pool.globalState()).tick).to.be.lt(-120)
    })

    describe('fee is on', () => {
      beforeEach(() => pool.setCommunityFee(170))
      it('limit selling 0 for 1 at tick 0 thru 1', async () => {
        await expect(mint(wallet.address, 0, 120, expandTo18Decimals(1)))
          .to.emit(token0, 'Transfer')
          .withArgs(wallet.address, pool.address, '5981737760509663')
        // somebody takes the limit order
        await swapExact1For0(expandTo18Decimals(2), other.address)
        await expect(pool.burn(0, 120, expandTo18Decimals(1)))
          .to.emit(pool, 'Burn')
          .withArgs(wallet.address, 0, 120, expandTo18Decimals(1), 0, '6017734268818165')
          .to.not.emit(token0, 'Transfer')
          .to.not.emit(token1, 'Transfer')
        await expect(pool.collect(wallet.address, 0, 120, MaxUint128, MaxUint128))
          .to.emit(token1, 'Transfer')
          .withArgs(pool.address, wallet.address, BigNumber.from('6017734268818165').add('499521896501'))
        expect((await pool.globalState()).tick).to.be.gte(120)
      })
      it('limit selling 1 for 0 at tick 0 thru -1', async () => {
        await expect(mint(wallet.address, -120, 0, expandTo18Decimals(1)))
          .to.emit(token1, 'Transfer')
          .withArgs(wallet.address, pool.address, '5981737760509663')
        // somebody takes the limit order
        await swapExact0For1(expandTo18Decimals(2), other.address)
        await expect(pool.burn(-120, 0, expandTo18Decimals(1)))
          .to.emit(pool, 'Burn')
          .withArgs(wallet.address, -120, 0, expandTo18Decimals(1), '6017734268818165', 0)
          .to.not.emit(token0, 'Transfer')
          .to.not.emit(token1, 'Transfer')
        await expect(pool.collect(wallet.address, -120, 0, MaxUint128, MaxUint128))
          .to.emit(token0, 'Transfer')
          .withArgs(pool.address, wallet.address, BigNumber.from('6017734268818165').add('499521896501'))
        expect((await pool.globalState()).tick).to.be.lt(-120)
      })
    })
  })

  describe('#collect', () => {
    beforeEach(async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('works with multiple LPs', async () => {
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      await mint(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, expandTo18Decimals(2))

      await swapExact0For1(expandTo18Decimals(1), wallet.address)
      // poke positions
      await pool.burn(minTick, maxTick, 0)
      await pool.burn(minTick + tickSpacing, maxTick - tickSpacing, 0)

      const { fees0: fees0Position0 } = await pool.positions(
        await getPositionKey(wallet.address, minTick, maxTick, pool)
      )
      const { fees0: fees0Position1 } = await pool.positions(
        await getPositionKey(wallet.address, minTick + tickSpacing, maxTick - tickSpacing, pool)
      )

      expect(fees0Position0).to.be.eq('33333333333333')
      expect(fees0Position1).to.be.eq('66666666666666')
    })

    describe('works across large increases', () => {
      beforeEach(async () => {
        await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
      })

      // type(uint128).max * 2**128 / 1e18
      // https://www.wolframalpha.com/input/?i=%282**128+-+1%29+*+2**128+%2F+1e18
      const magicNumber = BigNumber.from('115792089237316195423570985008687907852929702298719625575994')

      it('works just before the cap binds', async () => {
        await pool.setTotalFeeGrowth0Token(magicNumber)
        await pool.burn(minTick, maxTick, 0)

        const { fees0, fees1 } = await pool.positions( await getPositionKey(wallet.address, minTick, maxTick, pool))

        expect(fees0).to.be.eq(MaxUint128.sub(1))
        expect(fees1).to.be.eq(0)
      })

      it('works just after the cap binds', async () => {
        await pool.setTotalFeeGrowth0Token(magicNumber.add(1))
        await pool.burn(minTick, maxTick, 0)

        const { fees0, fees1 } = await pool.positions(await getPositionKey(wallet.address, minTick, maxTick, pool))

        expect(fees0).to.be.eq(MaxUint128)
        expect(fees1).to.be.eq(0)
      })

      it('works well after the cap binds', async () => {
        await pool.setTotalFeeGrowth0Token(constants.MaxUint256)
        await pool.burn(minTick, maxTick, 0)

        const { fees0, fees1 } = await pool.positions(await getPositionKey(wallet.address, minTick, maxTick, pool))

        expect(fees0).to.be.eq(MaxUint128)
        expect(fees1).to.be.eq(0)
      })
    })

    describe('works across overflow boundaries', () => {
      beforeEach(async () => {
        await pool.setTotalFeeGrowth0Token(constants.MaxUint256)
        await pool.setTotalFeeGrowth1Token(constants.MaxUint256)
        await mint(wallet.address, minTick, maxTick, expandTo18Decimals(10))
      })

      it('token0', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('99999999999999')
        expect(amount1).to.be.eq(0)
      })

      it('unexpected donation', async () => {
        await token1.transfer(pool.address, expandTo18Decimals(1))
        await token0.transfer(pool.address, expandTo18Decimals(2))
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('1999999999999999999')
        expect(amount1).to.be.eq('999999999999999999')
      })
      it('token0 with unexpected donation before burn', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await token0.transfer(pool.address, expandTo18Decimals(1))
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('1000099999999999999')
        expect(amount1).to.be.eq(0)
      })
      it('token0 with unexpected donation before swap', async () => {
        await token0.transfer(pool.address, expandTo18Decimals(1))
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('1000099999999999999')
        expect(amount1).to.be.eq(0)
      })
      it('token1', async () => {
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq(0)
        expect(amount1).to.be.eq('99999999999999')
      })
      it('token1 with unexpected donation before burn', async () => {
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await token1.transfer(pool.address, expandTo18Decimals(1))
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq(0)
        expect(amount1).to.be.eq('1000099999999999999')
      })
      it('token1 with unexpected donation before swap', async () => {
        await token1.transfer(pool.address, expandTo18Decimals(1))
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq(0)
        expect(amount1).to.be.eq('1000099999999999999')
      })
      it('token0 and token1', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('99999999999999')
        expect(amount1).to.be.eq('99999999999999')
      })
      it('token0 and token1 with unexpected donation before burn', async () => {
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await token1.transfer(pool.address, expandTo18Decimals(1))
        await token0.transfer(pool.address, expandTo18Decimals(2))
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('2000099999999999999')
        expect(amount1).to.be.eq('1000099999999999999')
      })
      it('token0 and token1 with unexpected donation before swaps', async () => {
        await token1.transfer(pool.address, expandTo18Decimals(1))
        await token0.transfer(pool.address, expandTo18Decimals(2))
        await swapExact0For1(expandTo18Decimals(1), wallet.address)
        await swapExact1For0(expandTo18Decimals(1), wallet.address)
        await pool.burn(minTick, maxTick, 0)
        const { amount0, amount1 } = await pool.callStatic.collect(
          wallet.address,
          minTick,
          maxTick,
          MaxUint128,
          MaxUint128
        )
        expect(amount0).to.be.eq('2000099999999999999')
        expect(amount1).to.be.eq('1000099999999999999')
      })
    })
  })

  describe('#communityFee', () => {
    const liquidityAmount = expandTo18Decimals(1000)

    beforeEach(async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, liquidityAmount)
    })

    it('is initially set to 0', async () => {
      expect((await pool.globalState()).communityFee).to.eq(0)
    })

    it('can be changed by the owner', async () => {
      await pool.setCommunityFee(170)
      expect((await pool.globalState()).communityFee).to.eq(170)
    })

    it('cannot be changed out of bounds', async () => {
      await expect(pool.setCommunityFee(251)).to.be.reverted
    })

    it('cannot be changed by addresses that are not owner', async () => {
      await expect(pool.connect(other).setCommunityFee(170)).to.be.reverted
    })

    async function swapAndGetFeesOwed({
      amount,
      zeroToOne,
      poke,
      supportingFee
    }: {
      amount: BigNumberish
      zeroToOne: boolean
      poke: boolean
      supportingFee?: boolean
    }) {
      if (supportingFee) {
        await (zeroToOne ? swapExact0For1SupportingFee(amount, wallet.address) : swapExact1For0SupportingFee(amount, wallet.address))
      } else {
        await (zeroToOne ? swapExact0For1(amount, wallet.address) : swapExact1For0(amount, wallet.address))
      }
      

      if (poke) await pool.burn(minTick, maxTick, 0)

      const { amount0: fees0, amount1: fees1 } = await pool.callStatic.collect(
        wallet.address,
        minTick,
        maxTick,
        MaxUint128,
        MaxUint128
      )

      expect(fees0, 'fees owed in token0 are greater than 0').to.be.gte(0)
      expect(fees1, 'fees owed in token1 are greater than 0').to.be.gte(0)

      return { token0Fees: fees0, token1Fees: fees1 }
    }

    it('position owner gets full fees when community fee is off', async () => {
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })

      // 6 bips * 1e18
      expect(token0Fees).to.eq('99999999999999')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (0 for 1)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq('99999999999999')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq('199999999999998')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      }))
      expect(token0Fees).to.eq('299999999999997')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (0 for 1), supporting fee on transfer', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('99999999999999')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('199999999999998')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('299999999999997')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (0 for 1), supporting fee on transfer community on', async () => {
      await pool.setCommunityFee(170)
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('82999999999999')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('165999999999998')
      expect(token1Fees).to.eq(0)
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq('248999999999997')
      expect(token1Fees).to.eq(0)
    })

    it('swap fees accumulate as expected (1 for 0)', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('99999999999999')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('199999999999998')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('299999999999997')
    })

    it('swap fees accumulate as expected (1 for 0) supporting fee on transfer', async () => {
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('99999999999999')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('199999999999998')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('299999999999997')
    })

    it('swap fees accumulate as expected (1 for 0) supporting fee on transfer community on', async () => {
      await pool.setCommunityFee(170)
      let token0Fees
      let token1Fees
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('82999999999999')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('165999999999998')
      ;({ token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: false,
        poke: true,
        supportingFee: true,
      }))
      expect(token0Fees).to.eq(0)
      expect(token1Fees).to.eq('248999999999997')
    })


    it('position owner gets partial fees when community fee is on', async () => {
      await pool.setCommunityFee(170)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })

      expect(token0Fees).to.be.eq('82999999999999')
      expect(token1Fees).to.be.eq(0)
    })

    it('fees collected by lp after two swaps should be double one swap', async () => {
      await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })
      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })

      // 1 bips * 2e18
      expect(token0Fees).to.eq('199999999999998')
      expect(token1Fees).to.eq(0)
    })

    it('fees collected after two swaps with fee turned on in middle are fees from last swap (not confiscatory)', async () => {
      await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: false,
      })

      await pool.setCommunityFee(170)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })

      expect(token0Fees).to.eq('182999999999999')
      expect(token1Fees).to.eq(0)
    })

    it('fees collected by lp after two swaps with intermediate withdrawal', async () => {
      await pool.setCommunityFee(170)

      const { token0Fees, token1Fees } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: true,
      })

      expect(token0Fees).to.eq('82999999999999')
      expect(token1Fees).to.eq(0)

      // collect the fees
      await pool.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)

      const { token0Fees: token0FeesNext, token1Fees: token1FeesNext } = await swapAndGetFeesOwed({
        amount: expandTo18Decimals(1),
        zeroToOne: true,
        poke: false,
      })

      expect(token0FeesNext).to.eq(0)
      expect(token1FeesNext).to.eq(0)

      expect((await token0.balanceOf(vaultAddress)).toString()).to.eq('17000000000000')
      const [communityFeePending0,] = await pool.getCommunityFeePending();
      expect(communityFeePending0).to.be.eq('17000000000000');
      expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(0)

      await pool.burn(minTick, maxTick, 0) // poke to update fees
      await expect(pool.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128))
        .to.emit(token0, 'Transfer')
        .withArgs(pool.address, wallet.address, '82999999999999')
      expect((await token0.balanceOf(vaultAddress)).toString()).to.eq('17000000000000')
      
      const [communityFeePending0After,] = await pool.getCommunityFeePending();
      expect(communityFeePending0After).to.be.eq('17000000000000');
      expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(0)
    })
  })

  describe('#tickSpacing', () => {
      beforeEach('deploy pool', async () => {
        pool = await createPoolWrapped()
      })
      describe('post initialize', () => {
        beforeEach('initialize pool', async () => {
          await pool.initialize(encodePriceSqrt(1, 1))
        })
        it('mint can only be called for multiples of 60', async () => {
          await expect(mint(wallet.address, -61, 0, 1)).to.be.reverted
          await expect(mint(wallet.address, 0, 6, 1)).to.be.reverted
        })
        it('mint can be called with multiples of 60', async () => {
          await mint(wallet.address, 60, 120, 1)
          await mint(wallet.address, -240, -180, 1)
        })
        it('swapping across gaps works in 1 for 0 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1).div(4)
          await mint(wallet.address, 120000, 121200, liquidityAmount)
          await swapExact1For0(expandTo18Decimals(1), wallet.address)
          await expect(pool.burn(120000, 121200, liquidityAmount))
            .to.emit(pool, 'Burn')
            .withArgs(wallet.address, 120000, 121200, liquidityAmount, '30009977315155', '999899999999999999')
            .to.not.emit(token0, 'Transfer')
            .to.not.emit(token1, 'Transfer')
          expect((await pool.globalState()).tick).to.eq(120197)
        })
        it('swapping across gaps works in 0 for 1 direction', async () => {
          const liquidityAmount = expandTo18Decimals(1).div(4)
          await mint(wallet.address, -121200, -120000, liquidityAmount)
          await swapExact0For1(expandTo18Decimals(1), wallet.address)
          await expect(pool.burn(-121200, -120000, liquidityAmount))
            .to.emit(pool, 'Burn')
            .withArgs(wallet.address, -121200, -120000, liquidityAmount, '999899999999999999', '30009977315155')
            .to.not.emit(token0, 'Transfer')
            .to.not.emit(token1, 'Transfer')
          expect((await pool.globalState()).tick).to.eq(-120198)
        })
      })
  })

  it('tickMath handles tick overflow', async() => {
    const sqrtTickMath = (await (await ethers.getContractFactory('TickMathTest')).deploy()) as TickMathTest
    await expect(sqrtTickMath.getSqrtRatioAtTick(887273)).to.be.revertedWithCustomError(sqrtTickMath, 'tickOutOfRange');
    await expect(sqrtTickMath.getSqrtRatioAtTick(-887273)).to.be.revertedWithCustomError(sqrtTickMath, 'tickOutOfRange');
  })

  xit('tick transition cannot run twice if zero for one swap ends at fractional price just below tick', async () => {
    pool = await createPoolWrapped()
    const sqrtTickMath = (await (await ethers.getContractFactory('TickMathTest')).deploy()) as TickMathTest
    const PriceMovementMath = (await (await ethers.getContractFactory('PriceMovementMathTest')).deploy()) as PriceMovementMathTest
    const p0 = (await sqrtTickMath.getSqrtRatioAtTick(-24081)).add(1)
    // initialize at a price of ~0.3 token1/token0
    // meaning if you swap in 2 token0, you should end up getting 0 token1
    await pool.initialize(p0)
    expect(await pool.liquidity(), 'current pool liquidity is 1').to.eq(0)
    expect((await pool.globalState()).tick, 'pool tick is -24081').to.eq(-24081)

    // add a bunch of liquidity around current price
    const liquidity = expandTo18Decimals(1000)
    await mint(wallet.address, -24082, -24080, liquidity)
    expect(await pool.liquidity(), 'current pool liquidity is now liquidity + 1').to.eq(liquidity)

    await mint(wallet.address, -24082, -24081, liquidity)
    expect(await pool.liquidity(), 'current pool liquidity is still liquidity + 1').to.eq(liquidity)

    // check the math works out to moving the price down 1, sending no amount out, and having some amount remaining
    {
      const { feeAmount, amountIn, amountOut, sqrtQ } = await PriceMovementMath.movePriceTowardsTarget(
        p0,
        p0.sub(1),
        liquidity,
        3,
        FeeAmount.MEDIUM
      )
      expect(sqrtQ, 'price moves').to.eq(p0.sub(1))
      expect(feeAmount, 'fee amount is 1').to.eq(1)
      expect(amountIn, 'amount in is 1').to.eq(1)
      expect(amountOut, 'zero amount out').to.eq(0)
    }

    // swap 2 amount in, should get 0 amount out
    await expect(swapExact0For1(3, wallet.address))
      .to.emit(token0, 'Transfer')
      .withArgs(wallet.address, pool.address, 3)
      .to.not.emit(token1, 'Transfer')

    const { tick, price } = await pool.globalState()

    expect(tick, 'pool is at the next tick').to.eq(-24082)
    expect(price, 'pool price is still on the p0 boundary').to.eq(p0.sub(1))
    expect(await pool.liquidity(), 'pool has run tick transition and liquidity changed').to.eq(liquidity.mul(2))
  })

  describe('#adaptiveFee', function() {
    this.timeout(0);
    const liquidity = expandTo18Decimals(1000);
    const DAY = 60*60*24;
    beforeEach('initialize pool', async () => {
      await initializeAtZeroTick(pool)
    })

    async function trade(count: number, proportion: number, amount: BigNumberish, pause: number) {
      let vol0 = BigNumber.from(0);
      let vol1 = BigNumber.from(0);
      for (let i = 0; i < count; i++) {
          if (i % proportion == 0 ) {
            let b0 = await token0.balanceOf(wallet.address);
            await swapExact1For0(amount, wallet.address);
            vol0 = vol0.add((await token0.balanceOf(wallet.address)).sub(b0));
            vol1 = vol1.add(amount);
            await pool.advanceTime(pause);
          } else {
            let b1 = await token1.balanceOf(wallet.address);
            await swapExact0For1(amount, wallet.address);
            vol1 = vol1.add((await token1.balanceOf(wallet.address)).sub(b1));
            vol0 = vol0.add(amount);
            await pool.advanceTime(pause);
          }
      }
      //console.log('Vol0: ', vol0.div(BigNumber.from(10).pow(18)).toString());
      //console.log('Vol1: ', vol1.div(BigNumber.from(10).pow(18)).toString());
    }

    async function tradeStable(count: number, proportion: number, amount: number, pause: number) {
      let ticks = [];
      for (let i = 0; i < count; i++) {
          if (i % proportion == 0 ) {
            await swapExact1For0(expandTo18Decimals(amount*5), wallet.address);
            await swapToLowerPrice(encodePriceSqrt(1, 1), wallet.address);
            await swapExact1For0(expandTo18Decimals(amount/2), wallet.address);
            await pool.advanceTime(pause);
          } else {
            await swapToLowerPrice(encodePriceSqrt(1, 1), wallet.address);
            await pool.advanceTime(pause);
          }
          ticks.push((await pool.globalState()).tick);
      }
      console.log(ticks)
    }

    async function getStatistics(time: number) {
      let now = await dsOperator.getTimepoints([BigNumber.from(0)]);
      let then = await dsOperator.getTimepoints([BigNumber.from(time)]);
      return [now.volatilityCumulatives[0].sub(then.volatilityCumulatives[0]).div(BigNumber.from(DAY)),
      time]
    }

    it('doesnt change at 0 volume', async () => {
      let fee1 = (await pool.globalState()).fee;
      await mint(wallet.address, -6000, 6000, liquidity)
      let fee2 = (await pool.globalState()).fee;
      await pool.advanceTime(DAY + 600);
      await mint(wallet.address, -6000, 6000, 1)
      let fee3 = (await pool.globalState()).fee;
      expect(fee3).to.be.equal(fee2);
      expect(fee3).to.be.equal(fee1);
    })

    const AMOUNT = 500000000
    it('single huge step after day', async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, -24000, 24000, liquidity.mul(BigNumber.from(1000000000)))

      await pool.advanceTime(DAY)
      await swapExact0For1(BigNumber.from(1000), wallet.address);
      await pool.advanceTime(60)
      await swapExact1For0(liquidity.mul(BigNumber.from(AMOUNT)), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      let fee3 = (await pool.globalState()).fee;
      expect(fee3).to.be.equal(3000);

      let stats = [];
      for (let i = 0; i < 25; i++) {
        await swapExact0For1(BigNumber.from(100), wallet.address);
        const avgVolatility = await pool.getAverageVolatility();
        let fee = (await pool.globalState()).fee;
        stats.push(`Fee: ${fee}, Avg_volat: ${avgVolatility.toString()} `);
        await pool.advanceTime(60*60)
      }
      expect(stats).to.matchSnapshot('fee stats after step');
    })

    it('single huge step after initialization', async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, -24000, 24000, liquidity.mul(BigNumber.from(1000000000)))

      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(1000), wallet.address);
      await pool.advanceTime(60)
      await swapExact1For0(liquidity.mul(BigNumber.from(AMOUNT)), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      let fee3 = (await pool.globalState()).fee;
      expect(fee3).to.be.equal(15000);

      let stats = [];
      for (let i = 0; i < 25; i++) {
        await swapExact0For1(BigNumber.from(100), wallet.address);
        const avgVolatility = await pool.getAverageVolatility();
        let fee = (await pool.globalState()).fee;
        stats.push(`Fee: ${fee}, Avg_volat: ${avgVolatility.toString()} `);
        await pool.advanceTime(60*60)
      }
      expect(stats).to.matchSnapshot('fee stats after step');
    })

    it('single huge spike after day', async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, -24000, 24000, liquidity.mul(BigNumber.from(1000000000)))
      await pool.advanceTime(DAY)
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(1000), wallet.address);
      await pool.advanceTime(60)
      await swapExact1For0(liquidity.mul(BigNumber.from(AMOUNT)), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      let fee3 = (await pool.globalState()).fee;
      expect(fee3).to.be.equal(3000);

      await swapToLowerPrice(encodePriceSqrt(1, 1), wallet.address);
      await pool.advanceTime(60);

      let stats = [];
      for (let i = 0; i < 25; i++) {
        await swapExact0For1(BigNumber.from(100), wallet.address);
        let avgVolatility = await pool.getAverageVolatility();
        let fee = (await pool.globalState()).fee;
        stats.push(`Fee: ${fee}, Avg_volat: ${avgVolatility.toString()} `);
        await pool.advanceTime(60*60)
      }
      expect(stats).to.matchSnapshot('fee stats after spike');
    })

    it('single huge spike after initialization', async () => {
      pool = await createPoolWrapped()
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, -24000, 24000, liquidity.mul(BigNumber.from(1000000000)))

      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(1000), wallet.address);
      await pool.advanceTime(60)
      await swapExact1For0(liquidity.mul(BigNumber.from(AMOUNT)), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      await pool.advanceTime(60)
      await swapExact0For1(BigNumber.from(100), wallet.address);
      let fee3 = (await pool.globalState()).fee;
      expect(fee3).to.be.equal(15000);

      await swapToLowerPrice(encodePriceSqrt(1, 1), wallet.address);
      await pool.advanceTime(60);

      let stats = [];
      for (let i = 0; i < 25; i++) {
        await swapExact0For1(BigNumber.from(100), wallet.address);
        let avgVolatility = await pool.getAverageVolatility();
        let fee = (await pool.globalState()).fee;
        stats.push(`Fee: ${fee}, Avg_volat: ${avgVolatility.toString()} `);
        await pool.advanceTime(60*60)
      }
      expect(stats).to.matchSnapshot('fee stats after spike');
    })

    xit('changes', async () => {
      let fee1 = (await pool.globalState()).fee;
      let tick0 = (await pool.globalState()).tick;
      await mint(wallet.address, -6000, 6000, liquidity)
      let fee2 = (await pool.globalState()).fee;
      await pool.advanceTime(DAY + 600);
      await tradeStable(240, 2, 10, 30);
      let fee3 = (await pool.globalState()).fee;
      console.log(fee1, fee2, fee3);
      let tick1 = (await pool.globalState()).tick;
      let stats = await getStatistics(DAY);
      console.log('Tick:', tick1 - tick0)
      console.log('Volt:', stats[0].toString())
      console.log('Volm:', BigNumber.from(stats[1]).div(BigNumber.from(10).pow(18)).toString())
      console.log(DAY)
    })
  })

  describe('#limitOrdersBuiltIn', async() => {
    describe('success cases', () => {
      let balanceToken0: BigNumber
      let balanceToken1: BigNumber
      const AMOUNT = BigNumber.from(10).pow(18);
      beforeEach('init pool', async () => {
        await initializeAtZeroTick(pool)
        ;[balanceToken0, balanceToken1] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)])
      })

      it('creates limit order at higher price', async() => {
        await addLimitOrder(wallet.address, 60, AMOUNT);

        expect(await token0.balanceOf(pool.address)).to.be.eq(balanceToken0.add(AMOUNT));
        expect(await token1.balanceOf(pool.address)).to.be.eq(balanceToken1);
      })

      it('creates limit order at current tick', async() => {
        await addLimitOrder(wallet.address, 0, AMOUNT);

        expect(await token1.balanceOf(pool.address)).to.be.eq(balanceToken1.add(AMOUNT));
        expect(await token0.balanceOf(pool.address)).to.be.eq(balanceToken0);
      })

      it('increases limit order at higher price', async() => {
        await addLimitOrder(wallet.address, 60, AMOUNT);
        await addLimitOrder(wallet.address, 60, AMOUNT);

        expect(await token0.balanceOf(pool.address)).to.be.eq(balanceToken0.add(AMOUNT.add(AMOUNT)));
        expect(await token1.balanceOf(pool.address)).to.be.eq(balanceToken1);
      })

      it('creates limit order at lower price', async() => {
        await addLimitOrder(wallet.address, -60, AMOUNT);

        expect(await token1.balanceOf(pool.address)).to.be.eq(balanceToken1.add(AMOUNT));
        expect(await token0.balanceOf(pool.address)).to.be.eq(balanceToken0);
      })

      it('increases limit order at lower price', async() => {
        await addLimitOrder(wallet.address, -60, AMOUNT);
        await addLimitOrder(wallet.address, -60, AMOUNT);

        expect(await token1.balanceOf(pool.address)).to.be.eq(balanceToken1.add(AMOUNT.add(AMOUNT)));
        expect(await token0.balanceOf(pool.address)).to.be.eq(balanceToken0);
      })

      it('closes limit order at higher price without execution', async() => {
        await addLimitOrder(swapTarget.address, 60, AMOUNT);

        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)
        expect(balance0After).to.be.eq(balance0Before.add(AMOUNT));
        expect(balance1After).to.be.eq(balance1Before);
      })

      it('decreases limit order at higher price without execution', async() => {
        await addLimitOrder(swapTarget.address, 60, AMOUNT);

        await swapTarget.decreaseLimitOrder(pool.address, 60, AMOUNT.div(2));
        
        const { amount0, amount1 } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, 60); 
        expect(amount0).to.be.eq(AMOUNT.div(2));
        expect(amount1).to.be.eq(0);

        await swapTarget.decreaseLimitOrder(pool.address, 60, AMOUNT.sub(AMOUNT.div(2)));
        const { amount0: amount0After, amount1: amount1After } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, 60); 
        expect(amount0After).to.be.eq(AMOUNT);
        expect(amount1After).to.be.eq(0);
      })

      it('decreases limit order at lower price without execution', async() => {
        await addLimitOrder(swapTarget.address, -60, AMOUNT);

        await swapTarget.decreaseLimitOrder(pool.address, -60, AMOUNT.div(2));
        
        const { amount0, amount1 } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, -60); 
        expect(amount1).to.be.eq(AMOUNT.div(2));
        expect(amount0).to.be.eq(0);

        await swapTarget.decreaseLimitOrder(pool.address, -60, AMOUNT.sub(AMOUNT.div(2)));
        const { amount0: amount0After, amount1: amount1After } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, -60); 
        expect(amount1After).to.be.eq(AMOUNT);
        expect(amount0After).to.be.eq(0);
      })

      it('closes limit order at current tick without execution', async() => {
        await addLimitOrder(swapTarget.address, 0, AMOUNT);

        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 0);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)
        expect(balance1After).to.be.eq(balance1Before.add(AMOUNT));
        expect(balance0After).to.be.eq(balance0Before);
      })


      it('closes limit order at lower price without execution', async() => {
        await addLimitOrder(swapTarget.address, -60, AMOUNT);

        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)
        expect(balance1After).to.be.eq(balance1Before.add(AMOUNT));
        expect(balance0After).to.be.eq(balance0Before);
      })

      it('closes limit order at lower price without execution and do not trigger', async() => {
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        await swapTarget.decreaseLimitOrder(pool.address, -60, AMOUNT);

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;

        
        await addLimitOrder(swapTarget.address, -60, AMOUNT);

        await swapTarget.decreaseLimitOrder(pool.address, -60, 0);
        const { amount0, amount1 } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, -60); 
        expect(amount0).to.be.eq(0);
        expect(amount1).to.be.eq(AMOUNT);
      })

      it('closes limit order at lower price without execution in two steps and do not trigger', async() => {
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        await swapTarget.decreaseLimitOrder(pool.address, -60, AMOUNT.div(2));
        await swapTarget.decreaseLimitOrder(pool.address, -60, AMOUNT.sub(AMOUNT.div(2)));

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;

        
        await addLimitOrder(swapTarget.address, -60, AMOUNT);

        await swapTarget.decreaseLimitOrder(pool.address, -60, 0);
        const { amount0, amount1 } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, -60); 
        expect(amount0).to.be.eq(0);
        expect(amount1).to.be.eq(AMOUNT);
      })

      it('closes limit order at higher price without execution and do not trigger', async() => {
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        await swapTarget.decreaseLimitOrder(pool.address, 60, AMOUNT);

        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;

        
        await addLimitOrder(swapTarget.address, 60, AMOUNT);

        await swapTarget.decreaseLimitOrder(pool.address, 60, 0);
        const { amount0, amount1 } = await swapTarget.callStatic.collectLimitOrder(pool.address, wallet.address, 60); 
        expect(amount1).to.be.eq(0);
        expect(amount0).to.be.eq(AMOUNT);
      })


      it('closes limit order at higher price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance1After.sub(balance1Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance0After).to.be.eq(balance0Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at current tick with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 0, AMOUNT);
        

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 0);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1000000000000000000')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at current tick with partial execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 0, AMOUNT);
        

        await swapExact0For1(BigNumber.from(100).pow(5), wallet.address);

        const tick = (await pool.globalState()).tick;
        expect(tick).to.be.eq(0);

        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 0);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('9999499999')
        expect(balance1After).to.be.eq(balance1Before.add(AMOUNT.sub('9999499999')));

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at very low price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await pool.setTickSpacing(1, 1);
        await addLimitOrder(swapTarget.address, -776363, 1);
        

        await swapExact0For1(BigNumber.from(10000).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -776363);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('5191955326816067979274722217396937')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at very high price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await pool.setTickSpacing(1, 1);
        await addLimitOrder(swapTarget.address, 776362, 1);
        

        await swapExact1For0(BigNumber.from(10000).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 776362);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance1After.sub(balance1Before);

        expect(receivedAmount).to.be.eq('5191436182336866434775554296512811')
        expect(balance0After).to.be.eq(balance0Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution exactOut', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swap0ForExact1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at higher price with full execution for two users', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        await addLimitOrder(other.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance1After.sub(balance1Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance0After).to.be.eq(balance0Before);

        const otherBalance0Before = await token0.balanceOf(other.address) 
        const otherBalance1Before = await token1.balanceOf(other.address) 
        await pool.connect(other).burn(60, 60, 0);
        await pool.connect(other).collect(other.address, 60, 60, MaxUint128, MaxUint128);
        const otherBalance0After = await token0.balanceOf(other.address)
        const otherBalance1After = await token1.balanceOf(other.address)

        const receivedAmountOther = otherBalance1After.sub(otherBalance1Before);

        expect(receivedAmountOther).to.be.eq('1006017734268818165')
        expect(otherBalance0After).to.be.eq(otherBalance0Before);


        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes several limit orders at lower price with full execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        await addLimitOrder(swapTarget.address, -120, AMOUNT);

        await swapExact0For1(BigNumber.from(1000).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;

       expect(tick).to.be.lt(-121);
        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })


      it('closes limit order at lower price with full execution exactOut', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swap0ForExact1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })


      it('closes limit order at higher price with partial execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(10).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        expect(balance1After.sub(balance1Before)).to.be.eq('993940991409063328')
        expect(balance0After.sub(balance0Before)).to.be.eq('12004502950966676')

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with partial execution', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swapExact0For1(BigNumber.from(10).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;

        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        expect(balance0After.sub(balance0Before)).to.be.eq('993940991409063328')
        expect(balance1After.sub(balance1Before)).to.be.eq('12004502950966676')

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at higher price with full execution in two steps', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(10).pow(18), wallet.address);
        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance1After.sub(balance1Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance0After).to.be.eq(balance0Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution in two steps', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swapExact0For1(BigNumber.from(10).pow(18), wallet.address);
        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at higher price with full execution in three steps', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(10).pow(18), wallet.address);
        await swapExact1For0(BigNumber.from(1).pow(15), wallet.address);
        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, 60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance1After.sub(balance1Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance0After).to.be.eq(balance0Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution in two steps', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        
        await swapExact0For1(BigNumber.from(10).pow(18), wallet.address);
        await swapExact0For1(BigNumber.from(1).pow(15), wallet.address);
        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

      it('closes limit order at lower price with full execution in two steps exactOut', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        
        await swap0ForExact1(BigNumber.from(10).pow(18), wallet.address);
        await swap0ForExact1(BigNumber.from(1).pow(15), wallet.address);
        await swap0ForExact1(BigNumber.from(100).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const balance0Before = await token0.balanceOf(wallet.address) 
        const balance1Before = await token1.balanceOf(wallet.address) 
        await swapTarget.removeLimitOrder(pool.address, wallet.address, -60);
        const balance0After = await token0.balanceOf(wallet.address)
        const balance1After = await token1.balanceOf(wallet.address)

        const receivedAmount = balance0After.sub(balance0Before);

        expect(receivedAmount).to.be.eq('1006017734268818165')
        expect(balance1After).to.be.eq(balance1Before);

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })


      it('partial execution at higher price and return', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, 60, AMOUNT);
        

        await swapExact1For0(BigNumber.from(10).pow(18), wallet.address);
        await swapExact0For1(BigNumber.from(12).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const {amount0, amount1} = await swapTarget.callStatic.removeLimitOrder(pool.address, wallet.address, 60);

        expect(amount1).to.be.eq('993940991409063328')
        expect(amount0).to.be.eq('12004502950966676')

        await swapExact1For0(BigNumber.from(100).pow(18), wallet.address);

        const {amount0: amount0After, amount1: amount1After} = await swapTarget.callStatic.removeLimitOrder(pool.address, wallet.address, 60);

        expect(amount1After).to.be.eq('1006017734268818165')
        expect(amount0After).to.be.eq('0')

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })


      it('partial execution at lower price and return', async() => {
        const tickBefore = (await pool.globalState()).tick;
        await addLimitOrder(swapTarget.address, -60, AMOUNT);
        

        await swapExact0For1(BigNumber.from(10).pow(18), wallet.address);
        await swapExact1For0(BigNumber.from(12).pow(18), wallet.address);

        const tick = (await pool.globalState()).tick;


        const {amount0, amount1} = await swapTarget.callStatic.removeLimitOrder(pool.address,wallet.address, -60);

        expect(amount0).to.be.eq('993940991409063328')
        expect(amount1).to.be.eq('12004502950966676')

        await swapExact0For1(BigNumber.from(100).pow(18), wallet.address);

        const {amount0: amount0After, amount1: amount1After} = await swapTarget.callStatic.removeLimitOrder(pool.address, wallet.address, -60);

        expect(amount0After).to.be.eq('1006017734268818165')
        expect(amount1After).to.be.eq('0')

        const [poolBalance0After, poolBalance1After] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)]);
        const [reserve0, reserve1] = await pool.getReserves();
        expect(reserve0).to.be.eq(poolBalance0After);
        expect(reserve1).to.be.eq(poolBalance1After);
      })

    })
  })

  describe('#flash', () => {
    it('fails if not initialized', async () => {
      await expect(flash(100, 200, other.address)).to.be.reverted
      await expect(flash(100, 0, other.address)).to.be.reverted
      await expect(flash(0, 200, other.address)).to.be.reverted
    })
    it('fails if no liquidity and reserves', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await expect(flash(100, 200, other.address)).to.be.revertedWithCustomError(pool, 'transferFailed')
      await expect(flash(100, 0, other.address)).to.be.revertedWithCustomError(pool, 'transferFailed')
      await expect(flash(0, 200, other.address)).to.be.revertedWithCustomError(pool, 'transferFailed')
    })
    it('works with zero liquidity', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      const tickSpacing = await pool.tickSpacing()
      await mint(wallet.address, -tickSpacing, tickSpacing, initializeLiquidityAmount)
      await swapExact0For1(initializeLiquidityAmount.mul(10000), wallet.address);
      expect(await pool.liquidity()).to.be.eq(0);
      await expect(flash(100, 0, other.address)).to.emit(token0, 'Transfer')
      .withArgs(pool.address, other.address, 100)
      await expect(flash(100, 100, other.address)).to.be.revertedWithCustomError(pool, 'transferFailed')
    })

    describe('after liquidity added', () => {
      let balanceToken0: BigNumber
      let balanceToken1: BigNumber
      beforeEach('add some tokens', async () => {
        await initializeAtZeroTick(pool)
        ;[balanceToken0, balanceToken1] = await Promise.all([token0.balanceOf(pool.address), token1.balanceOf(pool.address)])
      })

      describe('fee off', () => {
        it('emits an event', async () => {
          await expect(flash(1001, 2001, other.address))
            .to.emit(pool, 'Flash')
            .withArgs(swapTarget.address, other.address, 1001, 2001, 1, 1)
        })

        it('transfers the amount0 to the recipient', async () => {
          await expect(flash(100, 200, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(pool.address, other.address, 100)
        })
        it('transfers the amount1 to the recipient', async () => {
          await expect(flash(100, 200, other.address))
            .to.emit(token1, 'Transfer')
            .withArgs(pool.address, other.address, 200)
        })
        it('can flash only token0', async () => {
          await expect(flash(101, 0, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(pool.address, other.address, 101)
            .to.not.emit(token1, 'Transfer')
        })
        it('can flash only token1', async () => {
          await expect(flash(0, 102, other.address))
            .to.emit(token1, 'Transfer')
            .withArgs(pool.address, other.address, 102)
            .to.not.emit(token0, 'Transfer')
        })
        it('can flash entire token balance', async () => {
          await expect(flash(balanceToken0, balanceToken1, other.address))
            .to.emit(token0, 'Transfer')
            .withArgs(pool.address, other.address, balanceToken0)
            .to.emit(token1, 'Transfer')
            .withArgs(pool.address, other.address, balanceToken1)
        })
        it('no-op if both amounts are 0', async () => {
          await expect(flash(0, 0, other.address)).to.not.emit(token0, 'Transfer').to.not.emit(token1, 'Transfer')
        })
        it('fails if flash amount is greater than token balance', async () => {
          await expect(flash(balanceToken0.add(1), balanceToken1, other.address)).to.be.reverted
          await expect(flash(balanceToken0, balanceToken1.add(1), other.address)).to.be.reverted
        })
        it('calls the flash callback on the sender with correct fee amounts', async () => {
          await expect(flash(1001, 2002, other.address)).to.emit(swapTarget, 'FlashCallback').withArgs(1, 1)
        })
        it('increases the fee growth by the expected amount', async () => {
          await flash(1001, 2002, other.address)
          expect(await pool.totalFeeGrowth0Token()).to.eq(0)
          expect(await pool.totalFeeGrowth1Token()).to.eq(0)

          await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(1).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(1).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('increases the fee growth by the expected amount after unexpected donation of token0', async () => {
          await token0.transfer(pool.address, expandTo18Decimals(2))
          await flash(1001, 2002, other.address)
          expect(await pool.totalFeeGrowth1Token()).to.eq(0)

          await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(expandTo18Decimals(2).add(1)).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(1).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('increases the fee growth by the expected amount after unexpected donation of token1', async () => {
          await token1.transfer(pool.address, expandTo18Decimals(1))
          await flash(1001, 2002, other.address)
          expect(await pool.totalFeeGrowth0Token()).to.eq(0)

          await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(1).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(expandTo18Decimals(1).add(1)).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('increases the fee growth by the expected amount after unexpected donation', async () => {
          await token0.transfer(pool.address, expandTo18Decimals(2))
          await token1.transfer(pool.address, expandTo18Decimals(1))
          await flash(1001, 2002, other.address)

          await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(expandTo18Decimals(2).add(1)).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(expandTo18Decimals(1).add(1)).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('fails if original balance not returned in either token', async () => {
          await expect(flash(1000, 0, other.address, 999, 0)).to.be.reverted
          await expect(flash(0, 1000, other.address, 0, 999)).to.be.reverted
        })
        it('fails if underpays either token', async () => {
          await expect(flash(1000, 0, other.address, 1000, 0)).to.be.reverted
          await expect(flash(0, 1000, other.address, 0, 1000)).to.be.reverted
        })
        it('allows donating token0', async () => {
          await expect(flash(0, 0, constants.AddressZero, 567, 0))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, pool.address, 567)
            .to.not.emit(token1, 'Transfer')
            await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(567).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('allows donating token1', async () => {
          await expect(flash(0, 0, constants.AddressZero, 0, 678))
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, pool.address, 678)
            .to.not.emit(token0, 'Transfer')
            await pool.burn(minTick, maxTick, 0) 
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(678).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('allows donating token0 and token1 together', async () => {
          await expect(flash(0, 0, constants.AddressZero, 789, 1234))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, pool.address, 789)
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, pool.address, 1234)

            await pool.burn(minTick, maxTick, 0) 

          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(789).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(1234).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
      })

      describe('fee on', () => {
        beforeEach('turn community fee on', async () => {
          await pool.setCommunityFee(170)
        })

        it('emits an event', async () => {
          await expect(flash(1001, 2001, other.address))
            .to.emit(pool, 'Flash')
            .withArgs(swapTarget.address, other.address, 1001, 2001, 1, 1)
        })

        it('increases the fee growth by the expected amount', async () => {
          await flash(20020, 16016*5, other.address)
          expect(await pool.totalFeeGrowth0Token()).to.eq(0)
          expect(await pool.totalFeeGrowth1Token()).to.eq(0)

          await pool.burn(minTick, maxTick, 0) 

          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(3).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(8).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )

          expect(Number((await token0.balanceOf(vaultAddress)).toString())).to.eq(0)
          expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(1)
        })
        it('allows donating token0', async () => {
          await expect(flash(0, 0, constants.AddressZero, 567, 0))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, pool.address, 567)
            .to.not.emit(token1, 'Transfer')

          await pool.burn(minTick, maxTick, 0) 

          const [communityFeePending0,] = await pool.getCommunityFeePending();
          expect(Number((communityFeePending0).toString())).to.eq(0)
          expect(Number((await token0.balanceOf(vaultAddress)).toString())).to.eq(96)

          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(471).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('allows donating token1', async () => {
          await expect(flash(0, 0, constants.AddressZero, 0, 678))
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, pool.address, 678)
            .to.not.emit(token0, 'Transfer')

          await pool.burn(minTick, maxTick, 0) 

          const [, communityFeePending1] = await pool.getCommunityFeePending();
          expect(Number((communityFeePending1).toString())).to.eq(0)
          expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(115)

          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(563).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
        it('allows donating token0 and token1 together', async () => {
          await expect(flash(0, 0, constants.AddressZero, 789, 1234))
            .to.emit(token0, 'Transfer')
            .withArgs(wallet.address, pool.address, 789)
            .to.emit(token1, 'Transfer')
            .withArgs(wallet.address, pool.address, 1234)
            
          await pool.burn(minTick, maxTick, 0) 

          const [communityFeePending0, communityFeePending1] = await pool.getCommunityFeePending();
          expect(Number((communityFeePending0).toString())).to.eq(0)
          expect(Number((communityFeePending1).toString())).to.eq(0)


          expect(Number((await token0.balanceOf(vaultAddress)).toString())).to.eq(134)
          expect(Number((await token1.balanceOf(vaultAddress)).toString())).to.eq(209)

          expect(await pool.totalFeeGrowth0Token()).to.eq(
            BigNumber.from(655).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
          expect(await pool.totalFeeGrowth1Token()).to.eq(
            BigNumber.from(1025).mul(BigNumber.from(2).pow(128)).div(expandTo18Decimals(2))
          )
        })
      })
    })
  })

  describe('#setCommunityFee', () => {
    beforeEach('initialize the pool', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
    })

    it('can only be called by factory owner', async () => {
      await expect(pool.connect(other).setCommunityFee(200)).to.be.reverted
    })
    it('fails if fee is gt 25%', async () => {
      await expect(pool.setCommunityFee(254)).to.be.reverted
    })
    it('succeeds for fee 25%', async () => {
      await pool.setCommunityFee(250)
    })
    it('succeeds for fee of 10%', async () => {
      await pool.setCommunityFee(100)
    })
    it('sets community fee', async () => {
      await pool.setCommunityFee(140)
      expect((await pool.globalState()).communityFee).to.eq(140)
    })
    it('can change community fee', async () => {
      await pool.setCommunityFee(140)
      await pool.setCommunityFee(200)
      expect((await pool.globalState()).communityFee).to.eq(200)
    })
    it('can turn off community fee', async () => {
      await pool.setCommunityFee(250)
      await pool.setCommunityFee(0)
      expect((await pool.globalState()).communityFee).to.eq(0)
    })
    it('emits an event when turned on', async () => {
      await expect(pool.setCommunityFee(140)).to.be.emit(pool, 'CommunityFee').withArgs(140)
    })
    it('emits an event when turned off', async () => {
      await pool.setCommunityFee(140)
      await expect(pool.setCommunityFee(0)).to.be.emit(pool, 'CommunityFee').withArgs(0)
    })
    it('emits an event when changed', async () => {
      await pool.setCommunityFee(250)
      await expect(pool.setCommunityFee(170)).to.be.emit(pool, 'CommunityFee').withArgs(170)
    })
    it('fails if unchanged', async () => {
      await pool.setCommunityFee(200)
      await expect(pool.setCommunityFee(200)).to.be.revertedWithCustomError(pool, 'invalidNewCommunityFee');
    })
  })

  describe('#lock', () => {
    beforeEach('initialize the pool', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })

    it('cannot reenter from swap callback', async () => {
      const reentrant = (await (
        await ethers.getContractFactory('TestAlgebraReentrantCallee')
      ).deploy()) as TestAlgebraReentrantCallee

      // the tests happen in solidity
      await expect(reentrant.swapToReenter(pool.address)).to.be.revertedWith('Unable to reenter')
    })
  })

  describe('#getInnerCumulatives', () => {
    const bottomTick = -TICK_SPACINGS[FeeAmount.MEDIUM]
    const topTick = TICK_SPACINGS[FeeAmount.MEDIUM]
    const tickSpacing = TICK_SPACINGS[FeeAmount.MEDIUM]
    beforeEach(async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, bottomTick, topTick, 10)
    })
    it('throws if ticks are in reverse order', async () => {
      await expect(pool.getInnerCumulatives(topTick, bottomTick)).to.be.reverted
    })
    it('throws if tick lower is too low', async () => {
      await expect(pool.getInnerCumulatives(MIN_TICK- 1, topTick)).be.reverted
    })
    it('throws if tick upper is too high', async () => {
      await expect(pool.getInnerCumulatives(bottomTick, MAX_TICK + 1)).be.reverted
    })
    it('throws if top tick is not initialized', async () => {
      await expect(pool.getInnerCumulatives(bottomTick, MAX_TICK-2)).be.revertedWithCustomError(pool, 'tickIsNotInitialized');
    })
    it('throws if bottom tick is not initialized', async () => {
      await expect(pool.getInnerCumulatives(bottomTick+2, topTick)).be.revertedWithCustomError(pool, 'tickIsNotInitialized');
    })

    it('is zero immediately after initialize', async () => {
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(0)
      expect(innerSecondsSpent).to.eq(0)
    })
    it('increases by expected amount when time elapses in the range', async () => {
      await pool.advanceTime(5)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(5).shl(128).div(10))
      expect(innerSecondsSpent).to.eq(5)
    })
    it('does not account for time increase above range', async () => {
      await pool.advanceTime(5)
      await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
      await pool.advanceTime(7)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)

      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(5).shl(128).div(10))
      expect(innerSecondsSpent).to.eq(5)
    })
    it('does not account for time increase below range', async () => {
      await pool.advanceTime(5)
      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address)
      await pool.advanceTime(7)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(5).shl(128).div(10))
      // tick is 0 for 5 seconds, then not in range
      expect(innerSecondsSpent).to.eq(5)
    })
    it('time increase below range is not counted', async () => {
      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address)
      await pool.advanceTime(5)
      await swapToHigherPrice(encodePriceSqrt(1, 1), wallet.address)
      await pool.advanceTime(7)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(7).shl(128).div(10))
      // tick is not in range then tick is 0 for 7 seconds
      expect(innerSecondsSpent).to.eq(7)
    })
    it('time increase above range is not counted', async () => {
      await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
      await pool.advanceTime(5)
      await swapToLowerPrice(encodePriceSqrt(1, 1), wallet.address)
      await pool.advanceTime(7)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(7).shl(128).div(10))
      expect((await pool.globalState()).tick).to.eq(0)
      expect(innerSecondsSpent).to.eq(7)
    })
    it('positions minted after time spent', async () => {
      await pool.advanceTime(5)
      await mint(wallet.address, topTick, getMaxTick(tickSpacing), 15)
      await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
      await pool.advanceTime(8)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(topTick, getMaxTick(tickSpacing))

      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(8).shl(128).div(15))
      expect(innerSecondsSpent).to.eq(8)
    })
    it('overlapping liquidity is aggregated', async () => {
      await mint(wallet.address, bottomTick, getMaxTick(tickSpacing), 15)
      await pool.advanceTime(5)
      await swapToHigherPrice(encodePriceSqrt(2, 1), wallet.address)
      await pool.advanceTime(8)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(bottomTick, topTick)
      expect(innerSecondsSpentPerLiquidity).to.eq(BigNumber.from(5).shl(128).div(25))
      expect(innerSecondsSpent).to.eq(5)
    })
    it('relative behavior of snapshots', async () => {
      await pool.advanceTime(5)
      await mint(wallet.address, getMinTick(tickSpacing), bottomTick, 15)
      const {
        innerSecondsSpentPerLiquidity: innerSecondsSpentPerLiquidityStart,
        innerSecondsSpent: innerSecondsSpentStart,
      } = await pool.getInnerCumulatives(getMinTick(tickSpacing), bottomTick)
      await pool.advanceTime(8)
      // 13 seconds in starting range, then 3 seconds in newly minted range
      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address)
      await pool.advanceTime(3)
      const {
        innerSecondsSpentPerLiquidity,
        innerSecondsSpent,
      } = await pool.getInnerCumulatives(getMinTick(tickSpacing), bottomTick)
      const expectedDiffSecondsPerLiquidity = BigNumber.from(3).shl(128).div(15)
      expect(innerSecondsSpentPerLiquidity.sub(innerSecondsSpentPerLiquidityStart)).to.eq(
        expectedDiffSecondsPerLiquidity
      )
      expect(innerSecondsSpentPerLiquidity).to.not.eq(expectedDiffSecondsPerLiquidity)
      expect(innerSecondsSpent - innerSecondsSpentStart).to.eq(3)
      expect(innerSecondsSpent).to.not.eq(3)
    })
  })

  describe('fees and reserves overflow scenarios', async () => {
    it('up to max uint 128 - 1', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      const [reserve0before, reserve1before] = await pool.getReserves();

      await flash(0, 0, wallet.address, MaxUint128.sub(1), MaxUint128.sub(1))

      await pool.burn(minTick, maxTick, 0)
      const [totalFeeGrowth0Token, totalFeeGrowth1Token] = await Promise.all([
        pool.totalFeeGrowth0Token(),
        pool.totalFeeGrowth1Token(),
      ])
      // all 1s in first 128 bits
      expect(totalFeeGrowth0Token).to.eq(MaxUint128.shl(128).sub(reserve0before.shl(128)))
      expect(totalFeeGrowth1Token).to.eq(MaxUint128.shl(128).sub(reserve1before.shl(128)))
      const { amount0, amount1 } = await pool.callStatic.collect(
        wallet.address,
        minTick,
        maxTick,
        MaxUint128,
        MaxUint128
      )
      expect(amount0).to.eq(MaxUint128.sub(1))
      expect(amount1).to.eq(MaxUint128.sub(1))
    })

    it('reserves overflow max uint 128', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      const [reserve0before, reserve1before] = await pool.getReserves();

      await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
      await flash(0, 0, wallet.address, 1, 1)

      await pool.burn(minTick, maxTick, 0)
      const [totalFeeGrowth0Token, totalFeeGrowth1Token] = await Promise.all([
        pool.totalFeeGrowth0Token(),
        pool.totalFeeGrowth1Token(),
      ])
      // all 1s in first 128 bits
      expect(totalFeeGrowth0Token).to.eq(MaxUint128.shl(128).sub(reserve0before.shl(128)))
      expect(totalFeeGrowth1Token).to.eq(MaxUint128.shl(128).sub(reserve0before.shl(128)))
      const { amount0, amount1 } = await pool.callStatic.collect(
        wallet.address,
        minTick,
        maxTick,
        MaxUint128,
        MaxUint128
      )
      // fees burned
      expect(amount0).to.eq(MaxUint128.sub(1))
      expect(amount1).to.eq(MaxUint128.sub(1))
    })

    it('overflow max uint 128 after poke burns fees owed to 0', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, MaxUint128, MaxUint128)
      await pool.burn(minTick, maxTick, 0)
      await flash(0, 0, wallet.address, 1, 1)
      await pool.burn(minTick, maxTick, 0)

      const { amount0, amount1 } = await pool.callStatic.collect(
        wallet.address,
        minTick,
        maxTick,
        MaxUint128,
        MaxUint128
      )
      // fees burned
      expect(amount0).to.eq(MaxUint128.sub(1))
      expect(amount1).to.eq(MaxUint128.sub(1))
    })

    it('two positions at the same snapshot', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await mint(other.address, minTick, maxTick, 1)
      const [reserve0before,] = await pool.getReserves();
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await pool.burn(minTick, maxTick, 0)
      const totalFeeGrowth0Token = await pool.totalFeeGrowth0Token()
      expect(totalFeeGrowth0Token).to.eq(MaxUint128.shl(128).sub(reserve0before.shl(128)).div(2))
      await flash(0, 0, wallet.address, 2, 0)
      await pool.burn(minTick, maxTick, 0)
      await pool.connect(other).burn(minTick, maxTick, 0)
      let { amount0 } = await pool.callStatic.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0, 'amount0 of wallet').to.eq(MaxUint128.div(2).sub(1))
      ;({ amount0 } = await pool
        .connect(other)
        .callStatic.collect(other.address, minTick, maxTick, MaxUint128, MaxUint128))
      expect(amount0, 'amount0 of other').to.eq(MaxUint128.div(2).sub(1))
    })

    it('two positions 1 wei of fees apart', async () => {
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, 1)
      await flash(0, 0, wallet.address, 1, 0)
      await mint(other.address, minTick, maxTick, 1)
      const totalFeeGrowth0TokenBefore = await pool.totalFeeGrowth0Token()
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await flash(0, 0, wallet.address, MaxUint128, 0)
      await pool.burn(minTick, maxTick, 0)
      const totalFeeGrowth0Token = await pool.totalFeeGrowth0Token()
      expect(totalFeeGrowth0Token).to.eq(
        totalFeeGrowth0TokenBefore.add(
          MaxUint128.sub(3).shl(128).div(2)
        )
      )
      await flash(0, 0, wallet.address, 2, 0)
      await pool.burn(minTick, maxTick, 0)
      await pool.connect(other).burn(minTick, maxTick, 0)
      let { amount0 } = await pool.callStatic.collect(wallet.address, minTick, maxTick, MaxUint128, MaxUint128)
      expect(amount0, 'amount0 of wallet').to.eq(MaxUint128.div(2))
      ;({ amount0 } = await pool
        .connect(other)
        .callStatic.collect(other.address, minTick, maxTick, MaxUint128, MaxUint128))
      expect(amount0, 'amount0 of other').to.eq(MaxUint128.div(2).sub(1))
    })
  })

  describe('swap underpayment tests', () => {
    let underpay: TestAlgebraSwapPay
    beforeEach('deploy swap test', async () => {
      const underpayFactory = await ethers.getContractFactory('TestAlgebraSwapPay')
      underpay = (await underpayFactory.deploy()) as TestAlgebraSwapPay
      await token0.approve(underpay.address, constants.MaxUint256)
      await token1.approve(underpay.address, constants.MaxUint256)
      await pool.initialize(encodePriceSqrt(1, 1))
      await mint(wallet.address, minTick, maxTick, expandTo18Decimals(1))
    })
    it('swap 0 tokens', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 0, 1, 0)
      ).to.be.revertedWithCustomError(pool, 'zeroAmountRequired')
    })

    it('underpay zero for one and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 1000, 1, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay hardly zero for one and exact in supporting fee on transfer', async () => {
      await expect(
        underpay.swapSupportingFee(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 1000, 0, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay zero for one and exact in supporting fee on transfer', async () => {
      await expect(
        underpay.swapSupportingFee(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 1000, 900, 0)
      ).to.be.not.reverted;
    })
    it('pay in the wrong token zero for one and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 1000, 0, 2000)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('overpay zero for one and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), 1000, 2000, 0)
      ).to.not.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay zero for one and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), -1000, 1, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('pay in the wrong token zero for one and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), -1000, 0, 2000)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('overpay zero for one and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, true, MIN_SQRT_RATIO.add(1), -1000, 2000, 0)
      ).to.not.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay one for zero and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), 1000, 0, 1)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay hardly one for zero and exact in supporting fee on transfer', async () => {
      await expect(
        underpay.swapSupportingFee(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), 1000, 0, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay one for zero and exact in supporting fee on transfer', async () => {
      await expect(
        underpay.swapSupportingFee(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), 1000, 0, 990)
      ).to.be.not.reverted
    })
    it('pay in the wrong token one for zero and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), 1000, 2000, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('overpay one for zero and exact in', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), 1000, 0, 2000)
      ).to.not.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('underpay one for zero and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), -1000, 0, 1)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('pay in the wrong token one for zero and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), -1000, 2000, 0)
      ).to.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
    it('overpay one for zero and exact out', async () => {
      await expect(
        underpay.swap(pool.address, wallet.address, false, MAX_SQRT_RATIO.sub(1), -1000, 0, 2000)
      ).to.not.be.revertedWithCustomError(pool, 'insufficientInputAmount')
    })
  })

  describe('virtual pool tests', () => {
    let virtualPoolMock: MockTimeVirtualPool;

    beforeEach('deploy virtualPoolMock', async () => {
      await factory.setFarmingAddress(wallet.address);
      const virtualPoolMockFactory = await ethers.getContractFactory('MockTimeVirtualPool');
      virtualPoolMock = (await virtualPoolMockFactory.deploy()) as MockTimeVirtualPool;
    })

    it('set incentive works', async() => {
      await pool.setIncentive(virtualPoolMock.address);
      expect(await pool.activeIncentive()).to.be.eq(virtualPoolMock.address);    
    })

    it('set incentive works only for Factory.farmingAddress', async() => {
      await factory.setFarmingAddress(ethers.constants.AddressZero);
      await expect(pool.setIncentive(virtualPoolMock.address)).to.be.reverted;  
    })

    it('swap with active incentive', async() => {
      await pool.setIncentive(virtualPoolMock.address);
      await pool.initialize(encodePriceSqrt(1, 1));
      await mint(wallet.address, -120, 120, 1);
      await mint(wallet.address, minTick, maxTick, 1);
      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address);

      expect(await pool.activeIncentive()).to.be.eq(virtualPoolMock.address);

      const tick = (await pool.globalState()).tick;
      expect(await virtualPoolMock.currentTick()).to.be.eq(tick);
      expect(await virtualPoolMock.timestamp()).to.be.gt(0);
    })

    it('swap with finished incentive', async() => {
      await virtualPoolMock.setIsExist(false);
      await pool.setIncentive(virtualPoolMock.address);
      await pool.initialize(encodePriceSqrt(1, 1));
      await mint(wallet.address, -120, 120, 1);
      await mint(wallet.address, minTick, maxTick, 1);
      expect(await pool.activeIncentive()).to.be.eq(virtualPoolMock.address);    

      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address);

      expect(await pool.activeIncentive()).to.be.eq(ethers.constants.AddressZero);
      expect(await virtualPoolMock.currentTick()).to.be.eq(0);
      expect(await virtualPoolMock.timestamp()).to.be.eq(0);
    })

    it('swap with not started yet incentive', async() => {
      await virtualPoolMock.setIsStarted(false);
      await pool.setIncentive(virtualPoolMock.address);
      await pool.initialize(encodePriceSqrt(1, 1));
      await mint(wallet.address, -120, 120, 1);
      await mint(wallet.address, minTick, maxTick, 1);
      expect(await pool.activeIncentive()).to.be.eq(virtualPoolMock.address);    

      await swapToLowerPrice(encodePriceSqrt(1, 2), wallet.address);

      const tick = (await pool.globalState()).tick;
      expect(await pool.activeIncentive()).to.be.eq(virtualPoolMock.address);
      expect(await virtualPoolMock.currentTick()).to.be.eq(tick);
      expect(await virtualPoolMock.timestamp()).to.be.eq(0);
    })
  })
})
