import { main } from "../../../src/memory-system/cli.ts";

process.exitCode = await main(["remember", ...process.argv.slice(2)]);
