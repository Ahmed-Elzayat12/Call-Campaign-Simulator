/**
 * Call Campaign Simulator — Interface Contract
 *
 * YOU MUST IMPLEMENT THESE INTERFACES.
 * Do not modify this file. Your solution will be tested against these types.
 *
 * Export your concrete implementation from a file called `solution.ts`:
 *
 *   export { Campaign } from "./your-campaign-file";
 *
 * Your Campaign class must implement ICampaign (below).
 */

// =============================================================================
// Clock Interface
// =============================================================================

/**
 * Abstraction over time. Your Campaign must use this for ALL time operations —
 * never call Date.now(), setTimeout(), or setInterval() directly.
 *
 * A real-time implementation is yours to build if you want one.
 * Tests will inject a simulated clock.
 */
export interface IClock {
  /** Returns current timestamp in milliseconds (like Date.now()) */
  now(): number;

  /** Schedule a callback after `delayMs` simulated milliseconds. Returns a timer ID. */
  setTimeout(callback: () => void, delayMs: number): number;

  /** Cancel a previously scheduled timer. */
  clearTimeout(id: number): void;
}

// =============================================================================
// Call Handler
// =============================================================================

export interface CallResult {
  /** Whether the call was answered */
  answered: boolean;
  /** Duration of the call in milliseconds */
  durationMs: number;
}

/**
 * Function that simulates placing a call.
 * The promise resolves when the call ends (after durationMs of simulated time).
 * Tests will inject a handler that controls outcomes and durations.
 */
export type CallHandler = (phoneNumber: string) => Promise<CallResult>;

// =============================================================================
// Campaign Configuration
// =============================================================================

export interface CampaignConfig {
  /** Array of phone numbers to call */
  customerList: string[];
  /** Daily start time in "HH:mm" format (e.g., "09:00") */
  startTime: string;
  /** Daily end time in "HH:mm" format (e.g., "17:00") */
  endTime: string;
  /** Maximum number of simultaneous active calls */
  maxConcurrentCalls: number;
  /** Maximum total call minutes allowed per calendar day */
  maxDailyMinutes: number;
  /** Maximum retry attempts per failed call (default: 2) */
  maxRetries: number;
  /** Delay in ms before retrying a failed call (default: 3600000) */
  retryDelayMs: number;
  /**
   * IANA timezone string (e.g., "America/New_York", "Africa/Cairo").
   * When provided, startTime/endTime are interpreted in this timezone
   * and the daily minute cap resets at midnight in this timezone.
   * Defaults to UTC if omitted.
   * (Plus Task — optional)
   */
  timezone?: string;
}

// =============================================================================
// Campaign Status
// =============================================================================

export type CampaignState = "idle" | "running" | "paused" | "completed";

export interface CampaignStatus {
  /** Current lifecycle state */
  state: CampaignState;
  /** How many numbers have been successfully called */
  totalProcessed: number;
  /** How many numbers have permanently failed (exhausted all retries) */
  totalFailed: number;
  /** How many calls are currently active right now */
  activeCalls: number;
  /** How many retries are scheduled but not yet executed */
  pendingRetries: number;
  /** Total minutes consumed today */
  dailyMinutesUsed: number;
}

// =============================================================================
// Campaign Interface
// =============================================================================

/**
 * Your Campaign class must implement this interface.
 *
 * Constructor signature:
 *   new Campaign(config: CampaignConfig, callHandler: CallHandler, clock: IClock)
 */
export interface ICampaign {
  /** Begin processing the customer list. */
  start(): void;

  /** Pause the campaign. No new calls should be initiated. Active calls may finish. */
  pause(): void;

  /** Resume a paused campaign. */
  resume(): void;

  /** Return the current status of the campaign. */
  getStatus(): CampaignStatus;
}
