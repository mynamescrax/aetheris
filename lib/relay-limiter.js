import { createWorkLimiter } from "./work-limiter.js";

// A streamed response outlives its route handler. Hold admission until the
// response finishes/closes, and cancel queued/upstream work on disconnect.
export function createRelayLimiter(limits) {
  const run = createWorkLimiter(limits);
  return function enter(request, response, key) {
    const controller = new AbortController();
    let release;
    const lifetime = new Promise((resolve) => {
      release = resolve;
    });
    let admit, refuse;
    const admission = new Promise((resolve, reject) => {
      admit = resolve;
      refuse = reject;
    });
    const ended = () => {
      controller.abort();
      release();
    };
    request.once("aborted", ended);
    response.once("finish", ended);
    response.once("close", ended);
    response.once("error", ended);
    if (request.aborted || response.destroyed || response.writableFinished)
      ended();
    run(
      key,
      () => {
        admit(controller.signal);
        return lifetime;
      },
      { signal: controller.signal },
    )
      .catch(refuse)
      .finally(() => {
        request.off("aborted", ended);
        response.off("finish", ended);
        response.off("close", ended);
        response.off("error", ended);
      });
    return admission;
  };
}
