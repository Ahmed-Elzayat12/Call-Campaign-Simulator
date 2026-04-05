import { Campaign } from "./campaign";
import { CallHandler, CallResult, IClock } from "./interfaces";

type TimerTask = {
  id: number;
  dueAt: number;
  callback: () => void;
};

class DemoClock implements IClock {
  private currentTime: number;
  private nextTimerId = 1;
  private timers: TimerTask[] = [];

  constructor(startTimeMs: number) {
    this.currentTime = startTimeMs;
  }

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextTimerId++;
    this.timers.push({
      id,
      dueAt: this.currentTime + Math.max(0, Math.floor(delayMs)),
      callback,
    });
    this.sortTimers();
    return id;
  }

  clearTimeout(id: number): void {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }

  runUntilIdle(maxSteps = 10_000): void {
    let steps = 0;

    while (this.timers.length > 0) {
      steps += 1;
      if (steps > maxSteps) {
        throw new Error("Demo clock exceeded maxSteps; possible scheduling loop.");
      }

      const nextTask = this.timers.shift();
      if (!nextTask) {
        return;
      }

      this.currentTime = nextTask.dueAt;
      nextTask.callback();
    }
  }

  private sortTimers(): void {
    this.timers.sort((left, right) => {
      if (left.dueAt !== right.dueAt) {
        return left.dueAt - right.dueAt;
      }

      return left.id - right.id;
    });
  }
}

function formatUtc(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function createDemoCallHandler(clock: IClock): CallHandler {
  let attemptCounter = 0;

  return (phoneNumber: string) =>
    new Promise<CallResult>((resolve) => {
      attemptCounter += 1;
      const callNumber = attemptCounter;
      const durationMs = ((callNumber % 4) + 1) * 60_000;
      const answered = callNumber % 3 !== 0;

      console.log(
        `[${formatUtc(clock.now())}] starting call ${callNumber} to ${phoneNumber} (${answered ? "success" : "fail"} in ${
          durationMs / 60_000
        } min)`,
      );

      clock.setTimeout(() => {
        resolve({ answered, durationMs });
      }, durationMs);
    });
}

async function main(): Promise<void> {
  const clock = new DemoClock(Date.UTC(2026, 0, 5, 8, 30, 0, 0));
  const customerList = Array.from({ length: 10 }, (_, index) => `+1555000${String(index + 1).padStart(3, "0")}`);
  const callHandler = createDemoCallHandler(clock);

  const campaign = new Campaign(
    {
      customerList,
      startTime: "09:00",
      endTime: "17:00",
      maxConcurrentCalls: 3,
      maxDailyMinutes: 20,
      maxRetries: 2,
      retryDelayMs: 2 * 60 * 60 * 1000,
      timezone: "UTC",
    },
    callHandler,
    clock,
  );

  console.log(`Initial status:`, campaign.getStatus());
  campaign.start();
  clock.runUntilIdle();

  await Promise.resolve();
  clock.runUntilIdle();

  console.log(`Final status:`, campaign.getStatus());
  console.log(`Finished at ${formatUtc(clock.now())}`);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
