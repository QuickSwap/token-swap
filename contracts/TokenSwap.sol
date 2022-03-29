// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.12;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract TokenSwap is Ownable {
    using SafeERC20 for IERC20; 
 
    // Swap ratio from QUICK to xQUICK multiplied by 1000.
    uint256 public immutable swapRatio;

    // QUICK token address
    IERC20 public immutable quick;

    // xQUICK token address
    IERC20 public immutable quickX;
    
    // Number of blocks after which the owner will be able to withdraw the remaining xQUICK tokens
    uint256 public withdrawTimeout;


    address public constant DEAD = address(0x000000000000000000000000000000000000dEaD);

    /**
     * @dev Emitted when someone swap QUICK for xQUICK
     */
    event QuickToQuickX(uint256 quickAmount, uint256 quickxAmount, address indexed account);

    /**
     * @dev Emitted when the owner increases the timeout
     */
    event NewWithdrawTimeout(uint256 newWithdrawTimeout);

    /**
     * @dev Emitted when the owner withdraw tokens
     */
    event WithdrawTokens(address tokenAddress, uint256 amount);

    /**
     * @dev This contract will receive xQUICK tokens, the users will be able to swap their QUICK tokens for xQUICK tokens
     *      as long as this contract holds enough amount. The swapped QUICK tokens will be burned(sent to DEAD address).
     *      Once the withdrawTimeout is reached, the owner will be able to withdraw the remaining xQUICK tokens.
     * @param _quick QUICK token address
     * @param _quickX xQUICK token address
     * @param duration Time in number of blocks after which the owner will be able to withdraw the xQUICK tokens
     * @param _swapRatio swap ratio for QUICK to xQUICK
     */
    constructor (
        IERC20 _quick,
        IERC20 _quickX,
        uint256 duration,
        uint256 _swapRatio
    ){
        require(_quick != address(0), "Invalid address");
        require(_quickX != address(0), "Invalid address");

        require(_swapRatio == 1000, "Invalid swap ratio");

        quick = _quick;
        quickX = _quickX;
        withdrawTimeout = block.number + duration;

    }

    /**
     * @notice Method that allows swap QUICK for xQUICK tokens at the ratio of 1 QUICK --> 1000 xQUICK
     * @param quickAmount Amount of QUICK to swap
     */
    function quickToQuickX(uint256 quickAmount) public {
        // receive and burn QUICK tokens
        quick.safeTransferFrom(msg.sender, DEAD, quickAmount);

        // transfer xQUICK tokens
        uint256 quickXAmount = quickAmount * swapRatio;
        quickX.safeTransfer(msg.sender, quickXAmount);

        emit QuickToQuickX(quickAmount, quickXAmount, msg.sender);
    }

    /**
     * @notice Method that allows the owner to withdraw any token from this contract
     * In order to withdraw xQUICK tokens the owner must wait until the withdrawTimeout expires
     * @param tokenAddress Token address
     * @param amount Amount of tokens to withdraw
     */
    function withdrawTokens(address tokenAddress, uint256 amount) public onlyOwner {
        if(tokenAddress == address(quickX)) {
            require(
                block.number > withdrawTimeout,
                "TokenSwap::withdrawTokens: TIMEOUT_NOT_REACHED"
            );
        }
        
        IERC20(tokenAddress).safeTransfer(owner(), amount);

        emit WithdrawTokens(tokenAddress, amount);
    }

    /**
     * @notice Method that allows the owner to increase the withdraw timeout
     * @param newWithdrawTimeout new withdraw timeout
     */
    function setWithdrawTimeout(uint256 newWithdrawTimeout) public onlyOwner {
        require(
            newWithdrawTimeout > withdrawTimeout,
             "TokenSwap::setWithdrawTimeout: NEW_TIMEOUT_MUST_BE_HIGHER"
        );
        
        withdrawTimeout = newWithdrawTimeout; 
        
        emit NewWithdrawTimeout(newWithdrawTimeout);
    }
}