import { ApiError } from "../protocol/errors.ts";
import { envNumber } from "../support/env.ts";

// A server-wide ceiling on YouCam tasks per UTC day, so a bug or a runaway
// agent cannot spend an account's balance. It is kept in memory: a deployment
// with several instances sets YOUCAM_DAILY_TASK_CAP per instance or puts a
// shared counter behind this function.

let day = "";
let used = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Counts one YouCam task, or throws a 429 when today's cap is reached. */
export function reserveYouCamTask(): void {
  const now = today();
  if (now !== day) {
    day = now;
    used = 0;
  }
  const cap = envNumber("YOUCAM_DAILY_TASK_CAP", 300);
  if (used >= cap)
    throw new ApiError(
      429,
      "rate_limited",
      "YouCam analysis has reached today's limit.",
    );
  used += 1;
}

/** Gives a task back when it never reached YouCam. */
export function releaseYouCamTask(): void {
  if (used > 0) used -= 1;
}

export function youcamTasksUsedToday(): number {
  return today() === day ? used : 0;
}

/** Resets the counter. For tests. */
export function resetYouCamTasks(): void {
  day = "";
  used = 0;
}
