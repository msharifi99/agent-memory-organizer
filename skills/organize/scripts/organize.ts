import { main } from "../../../src/memory-system/cli.ts";

process.exitCode = await main(["organize", ...process.argv.slice(2)]);
