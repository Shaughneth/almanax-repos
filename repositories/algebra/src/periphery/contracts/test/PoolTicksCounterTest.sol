// SPDX-License-Identifier: GPL-2.0-or-later
import '../../../core/contracts/interfaces/IAlgebraPool.sol';

pragma solidity >=0.8.17;

import '../libraries/PoolTicksCounter.sol';

contract PoolTicksCounterTest {
    using PoolTicksCounter for IAlgebraPool;

    function countInitializedTicksCrossed(
        IAlgebraPool pool,
        int24 tickBefore,
        int24 tickAfter
    ) external view returns (uint32 initializedTicksCrossed) {
        return pool.countInitializedTicksCrossed(tickBefore, tickAfter);
    }
}
