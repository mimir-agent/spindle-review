import { claudeReview, main } from "./cli.ts";

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  fetch,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  now: () => new Date(),
  review: claudeReview(process.env),
});
