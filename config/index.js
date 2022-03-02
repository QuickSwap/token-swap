const polygon = require("./polygon.json");
const mainnet = require("./mainnet.json");

const configs = { "137": polygon, "1": mainnet, "31337": polygon };

const getConfig = (network)=>{
    return configs[network];
}

module.exports = {
    getConfig
}
