// One worker owns the queue. The readiness check is repeated after each job so
// request-local failures may advance while a system failure stops later jobs.
export function createJobQueue({ canRun, nextJob, runJob }) {
  let active = false;
  return async function runQueue() {
    if (active || !canRun()) return;
    active = true;
    try {
      while (canRun()) {
        const next = nextJob();
        if (!next) break;
        await runJob(next);
      }
    } finally {
      active = false;
    }
  };
}
