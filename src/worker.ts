import { client } from "@/db/client";
import {
  claimNextOcrJob,
  processOcrJob,
  reclaimStaleOcrJobs,
} from "@/services/ocr";

const POLL_INTERVAL_MS = 1000;

let shuttingDown = false;

function requestShutdown(): void {
  shuttingDown = true;
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(JSON.stringify({ component: "worker", event: "started" }));
  while (!shuttingDown) {
    try {
      await reclaimStaleOcrJobs();
      const claimed = await claimNextOcrJob();
      if (claimed === null) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await processOcrJob(claimed.jobId);
    } catch (error) {
      console.error(
        JSON.stringify({
          component: "worker",
          event: "loop_error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await sleep(POLL_INTERVAL_MS);
    }
  }
  console.log(JSON.stringify({ component: "worker", event: "stopped" }));
  await client.end();
  process.exit(0);
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      component: "worker",
      event: "fatal",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
