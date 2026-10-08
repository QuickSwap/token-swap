// Prints the constructor `duration` (blocks) for each converter from explicit inputs. No network access.
//
// Usage:
//   node scripts/converter-duration.js --block-number <n> --block-timestamp <unix s> --observed-block-time-ms <ms>
//     --end-750 <UTC> --end-500 <UTC> --end-250 <UTC>
//     [--margin-seconds 86400] [--assumed-block-time-ms 3000] [--inclusion-allowance-seconds 600] [--json]
//
// end-750 is when the 500 phase starts, end-500 when the 250 phase starts, end-250 the final close.
// Block number and timestamp come from `cast block latest`; the observed block time is the average over two blocks.
const {
  DEFAULT_MARGIN_SECONDS,
  DEFAULT_ASSUMED_BLOCK_TIME_MS,
  DEFAULT_INCLUSION_ALLOWANCE_SECONDS,
  parseCutover,
  deriveWithdrawDuration,
  estimateTimestampAtBlock,
} = require("./lib/withdraw-timeout");

const RATIOS = [750, 500, 250];
const VALUE_FLAGS = [
  "--block-number", "--block-timestamp", "--observed-block-time-ms", "--end-750", "--end-500", "--end-250",
  "--margin-seconds", "--assumed-block-time-ms", "--inclusion-allowance-seconds",
];
const iso = (seconds) => new Date(seconds * 1000).toISOString();

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--json") options.json = true;
    else if (VALUE_FLAGS.includes(flag)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[flag] = value;
      i += 1;
    } else throw new Error(`Unknown argument ${flag}`);
  }
  return options;
}

function integer(options, flag, fallback) {
  const value = options[flag];
  if (value === undefined) {
    if (fallback === undefined) throw new Error(`${flag} is required`);
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} must be a non-negative decimal integer, got "${value}"`);
  }
  return Number(value);
}

function run(argv) {
  const options = parseArgs(argv);
  const referenceBlock = { number: integer(options, "--block-number"), timestamp: integer(options, "--block-timestamp") };
  const observedBlockTimeMs = integer(options, "--observed-block-time-ms");
  const ends = RATIOS.map((ratio) => parseCutover(options[`--end-${ratio}`], `--end-${ratio}`));
  if (!(ends[0] < ends[1] && ends[1] < ends[2])) throw new Error("Cutovers must satisfy end-750 < end-500 < end-250");
  const common = {
    referenceBlock,
    observedBlockTimeMs,
    marginSeconds: integer(options, "--margin-seconds", DEFAULT_MARGIN_SECONDS),
    assumedBlockTimeMs: integer(options, "--assumed-block-time-ms", DEFAULT_ASSUMED_BLOCK_TIME_MS),
    inclusionAllowanceSeconds: integer(options, "--inclusion-allowance-seconds", DEFAULT_INCLUSION_ALLOWANCE_SECONDS),
  };
  const converters = RATIOS.map((ratio, i) => {
    const { durationBlocks, deadline, latestTimeoutTimestamp } = deriveWithdrawDuration({ ...common, outgoingCutover: ends[i] });
    // Estimate from the reference block at the observed block time.
    const estimated = estimateTimestampAtBlock({ referenceBlock, block: referenceBlock.number + durationBlocks, blockTimeMs: observedBlockTimeMs });
    return { ratio, durationBlocks, deadline: iso(deadline), latestTimeout: iso(latestTimeoutTimestamp), estimatedTimeout: iso(estimated) };
  });
  return { json: options.json === true, inputs: { ...common, ends: RATIOS.map((r) => options[`--end-${r}`]) }, converters };
}

if (require.main === module) {
  try {
    const result = run(process.argv.slice(2));
    if (result.json) console.log(JSON.stringify({ inputs: result.inputs, converters: result.converters }, null, 2));
    else for (const c of result.converters) {
      console.log(`ratio ${c.ratio}: durationBlocks ${c.durationBlocks}, deadline ${c.deadline}, latest timeout ${c.latestTimeout}, estimated timeout ${c.estimatedTimeout}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { run };
