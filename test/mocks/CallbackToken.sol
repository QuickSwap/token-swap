// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.12;

/**
 * @dev Minimal 18-decimal ERC20 used only by the tests. After every balance
 *      move it can call an arbitrary target once with preset calldata, and it
 *      bubbles up the target's revert data when that call fails.
 */
contract CallbackToken {
    string public constant name = "Callback Token";
    string public constant symbol = "CBT";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public hookTarget;
    bytes public hookData;
    bool public hookArmed;
    uint256 public hookCalls;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) {
        totalSupply = supply;
        balanceOf[msg.sender] = supply;
        emit Transfer(address(0), msg.sender, supply);
    }

    /// @notice Arms a single call to `target` with `data`, fired after the next balance move.
    function armHook(address target, bytes calldata data) external {
        hookTarget = target;
        hookData = data;
        hookArmed = true;
    }

    /// @notice Calls `target` with `data` from this contract's address.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            _bubble(ret);
        }
        return ret;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 current = allowance[from][msg.sender];
        require(current >= amount, "CallbackToken: insufficient allowance");
        allowance[from][msg.sender] = current - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "CallbackToken: transfer amount exceeds balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);

        if (hookArmed) {
            hookArmed = false;
            hookCalls += 1;
            (bool ok, bytes memory ret) = hookTarget.call(hookData);
            if (!ok) {
                _bubble(ret);
            }
        }
    }

    function _bubble(bytes memory ret) private pure {
        if (ret.length == 0) {
            revert("CallbackToken: call failed");
        }
        assembly {
            revert(add(ret, 32), mload(ret))
        }
    }
}
