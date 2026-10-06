const polygon = require("./polygon.json");
const mainnet = require("./mainnet.json");
const local = require("./local.json");

const LOCAL_CHAIN_ID = "31337";

const configs = { "137": polygon, "1": mainnet, [LOCAL_CHAIN_ID]: local };

const getConfig = (chainId) => {
    const config = configs[String(chainId)];
    if (!config) {
        throw new Error(`No deploy config for chain ${chainId}`);
    }
    return { ...config };
}

const isLocalChain = (chainId) => String(chainId) === LOCAL_CHAIN_ID;

module.exports = {
    getConfig,
    isLocalChain
}
