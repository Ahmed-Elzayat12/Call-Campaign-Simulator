import {
	CallHandler,
	CallResult,
	CampaignConfig,
	CampaignStatus,
	ICampaign,
	IClock,
} from "./interfaces";

type RetryTask = {
	customerIndex: number;
	attemptNumber: number;
	dueAt: number;
	sequence: number;
};

type LocalDateTimeParts = {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
};

type PhoneState = {
	completed: boolean;
	attemptsStarted: number;
};

const MINUTE_MS = 60_000;

export class Campaign implements ICampaign {
	private readonly config: CampaignConfig;
	private readonly callHandler: CallHandler;
	private readonly clock: IClock;
	private readonly timezone: string;
	private readonly startMinuteOfDay: number;
	private readonly endMinuteOfDay: number;
	private readonly customerStates: PhoneState[];
	private readonly dailyUsageMs = new Map<string, number>();
	private readonly localDateTimeFormatter: Intl.DateTimeFormat;

	private state: CampaignStatus["state"] = "idle";
	private nextCustomerIndex = 0;
	private totalProcessed = 0;
	private totalFailed = 0;
	private activeCalls = 0;
	private readonly retryQueue: RetryTask[] = [];
	private retrySequence = 0;
	private timerId: number | null = null;
	private isTickRunning = false;
	private rerunTickRequested = false;

	constructor(config: CampaignConfig, callHandler: CallHandler, clock: IClock) {
		this.config = this.validateConfig(config);
		this.callHandler = callHandler;
		this.clock = clock;
		this.timezone = this.config.timezone ?? "UTC";
		this.startMinuteOfDay = this.parseMinuteOfDay(this.config.startTime);
		this.endMinuteOfDay = this.parseMinuteOfDay(this.config.endTime);
		this.customerStates = this.config.customerList.map(() => ({
			completed: false,
			attemptsStarted: 0,
		}));
		this.localDateTimeFormatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: this.timezone,
			hour12: false,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
	}

	start(): void {
		if (this.state !== "idle") {
			return;
		}

		this.state = "running";
		this.requestTick();
	}

	pause(): void {
		if (this.state !== "running") {
			return;
		}

		this.state = "paused";
		this.clearTimer();
	}

	resume(): void {
		if (this.state !== "paused") {
			return;
		}

		this.state = "running";
		this.requestTick();
	}

	getStatus(): CampaignStatus {
		return {
			state: this.state,
			totalProcessed: this.totalProcessed,
			totalFailed: this.totalFailed,
			activeCalls: this.activeCalls,
			pendingRetries: this.retryQueue.length,
			dailyMinutesUsed: this.getCurrentDayUsageMs(this.clock.now()) / MINUTE_MS,
		};
	}

	private validateConfig(config: CampaignConfig): CampaignConfig {
		if (!Array.isArray(config.customerList)) {
			throw new TypeError("customerList must be an array of phone numbers.");
		}

		if (config.customerList.length === 0) {
			throw new Error("customerList must contain at least one phone number.");
		}

		if (
			!Number.isInteger(config.maxConcurrentCalls) ||
			config.maxConcurrentCalls <= 0
		) {
			throw new Error("maxConcurrentCalls must be a positive integer.");
		}

		if (
			!Number.isFinite(config.maxDailyMinutes) ||
			config.maxDailyMinutes < 0
		) {
			throw new Error("maxDailyMinutes must be a non-negative number.");
		}

		if (!Number.isInteger(config.maxRetries) || config.maxRetries < 0) {
			throw new Error("maxRetries must be a non-negative integer.");
		}

		if (!Number.isFinite(config.retryDelayMs) || config.retryDelayMs < 0) {
			throw new Error("retryDelayMs must be a non-negative number.");
		}

		const startMinuteOfDay = this.parseMinuteOfDay(config.startTime);
		const endMinuteOfDay = this.parseMinuteOfDay(config.endTime);

		if (startMinuteOfDay >= endMinuteOfDay) {
			throw new Error(
				"startTime must be earlier than endTime within the same local day.",
			);
		}

		if (config.timezone) {
			try {
				new Intl.DateTimeFormat("en-US", { timeZone: config.timezone }).format(
					0,
				);
			} catch {
				throw new Error(`Invalid timezone: ${config.timezone}`);
			}
		}

		return {
			...config,
			timezone: config.timezone ?? "UTC",
		};
	}

	private parseMinuteOfDay(value: string): number {
		const match = /^(\d{2}):(\d{2})$/.exec(value);
		if (!match) {
			throw new Error(`Invalid time value: ${value}`);
		}

		const hours = Number(match[1]);
		const minutes = Number(match[2]);

		if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
			throw new Error(`Invalid time value: ${value}`);
		}

		return hours * 60 + minutes;
	}

	private requestTick(delayMs = 0): void {
		if (this.state === "completed") {
			return;
		}

		if (this.isTickRunning) {
			this.rerunTickRequested = true;
			return;
		}

		this.scheduleTimer(delayMs);
	}

	private scheduleTimer(delayMs: number): void {
		const safeDelay = Math.max(0, Math.floor(delayMs));

		if (this.timerId !== null) {
			this.clock.clearTimeout(this.timerId);
			this.timerId = null;
		}

		this.timerId = this.clock.setTimeout(() => {
			this.timerId = null;
			this.runTick();
		}, safeDelay);
	}

	private clearTimer(): void {
		if (this.timerId !== null) {
			this.clock.clearTimeout(this.timerId);
			this.timerId = null;
		}
	}

	private runTick(): void {
		if (this.isTickRunning) {
			this.rerunTickRequested = true;
			return;
		}

		this.isTickRunning = true;

		try {
			while (this.shouldStartCallNow()) {
				const workItem = this.takeNextWorkItem(this.clock.now());
				if (!workItem) {
					break;
				}

				this.startCall(workItem.customerIndex, workItem.attemptNumber);
			}

			this.updateCompletionState();

			if (this.state === "running") {
				const nextDelay = this.computeNextTickDelay(this.clock.now());
				if (nextDelay === null) {
					this.clearTimer();
				} else {
					this.scheduleTimer(nextDelay);
				}
			} else if (this.state !== "completed") {
				this.clearTimer();
			}
		} finally {
			this.isTickRunning = false;
			if (this.rerunTickRequested) {
				this.rerunTickRequested = false;
				this.requestTick();
			}
		}
	}

	private shouldStartCallNow(): boolean {
		if (this.state !== "running") {
			return false;
		}

		if (this.activeCalls >= this.config.maxConcurrentCalls) {
			return false;
		}

		const now = this.clock.now();
		if (!this.isWithinWorkingWindow(now)) {
			return false;
		}

		if (
			this.getCurrentDayUsageMs(now) >=
			this.config.maxDailyMinutes * MINUTE_MS
		) {
			return false;
		}

		return this.hasDueWork(now);
	}

	private hasDueWork(now: number): boolean {
		return (
			this.getDueRetry(now) !== null ||
			this.nextCustomerIndex < this.config.customerList.length
		);
	}

	private getDueRetry(now: number): RetryTask | null {
		const firstRetry = this.retryQueue[0];
		if (!firstRetry || firstRetry.dueAt > now) {
			return null;
		}

		return firstRetry;
	}

	private takeNextWorkItem(
		now: number,
	): { customerIndex: number; attemptNumber: number } | null {
		const dueRetry = this.getDueRetry(now);
		if (dueRetry) {
			this.retryQueue.shift();
			return {
				customerIndex: dueRetry.customerIndex,
				attemptNumber: dueRetry.attemptNumber,
			};
		}

		if (this.nextCustomerIndex >= this.config.customerList.length) {
			return null;
		}

		const customerIndex = this.nextCustomerIndex;
		this.nextCustomerIndex += 1;

		return {
			customerIndex,
			attemptNumber: 0,
		};
	}

	private startCall(customerIndex: number, attemptNumber: number): void {
		const phoneState = this.customerStates[customerIndex];
		if (!phoneState) {
			throw new Error(`Unknown customer index: ${customerIndex}`);
		}

		phoneState.attemptsStarted += 1;
		this.activeCalls += 1;
		const startedAt = this.clock.now();
		const phoneNumber = this.config.customerList[customerIndex];

		void this.callHandler(phoneNumber)
			.then((result) =>
				this.handleCallResult(customerIndex, attemptNumber, startedAt, result),
			)
			.catch(() =>
				this.handleCallResult(customerIndex, attemptNumber, startedAt, {
					answered: false,
					durationMs: 0,
				}),
			);
	}

	private handleCallResult(
		customerIndex: number,
		attemptNumber: number,
		startedAt: number,
		result: CallResult,
	): void {
		const normalizedDurationMs = Math.max(0, Math.floor(result.durationMs));
		this.activeCalls = Math.max(0, this.activeCalls - 1);
		this.recordUsage(startedAt, normalizedDurationMs);

		const phoneState = this.customerStates[customerIndex];
		if (!phoneState || phoneState.completed) {
			this.requestTick();
			return;
		}

		if (result.answered) {
			phoneState.completed = true;
			this.totalProcessed += 1;
			this.requestTick();
			return;
		}

		if (attemptNumber < this.config.maxRetries) {
			this.enqueueRetry({
				customerIndex,
				attemptNumber: attemptNumber + 1,
				dueAt: this.clock.now() + this.config.retryDelayMs,
				sequence: this.retrySequence++,
			});
		} else {
			phoneState.completed = true;
			this.totalFailed += 1;
		}

		this.requestTick();
	}

	private enqueueRetry(task: RetryTask): void {
		this.retryQueue.push(task);
		this.retryQueue.sort((left, right) => {
			if (left.dueAt !== right.dueAt) {
				return left.dueAt - right.dueAt;
			}

			return left.sequence - right.sequence;
		});
	}

	private updateCompletionState(): void {
		if (this.state === "completed") {
			return;
		}

		if (this.activeCalls > 0) {
			return;
		}

		if (this.retryQueue.length > 0) {
			return;
		}

		if (this.nextCustomerIndex < this.config.customerList.length) {
			return;
		}

		this.state = "completed";
		this.clearTimer();
	}

	private computeNextTickDelay(now: number): number | null {
		if (this.state !== "running") {
			return null;
		}

		if (this.shouldStartCallNow()) {
			return 0;
		}

		const candidates: number[] = [];

		if (!this.isWithinWorkingWindow(now)) {
			candidates.push(this.getNextWorkingWindowStart(now));
		}

		if (
			this.getCurrentDayUsageMs(now) >=
			this.config.maxDailyMinutes * MINUTE_MS
		) {
			candidates.push(this.getNextLocalMidnight(now));
		}

		if (
			this.activeCalls < this.config.maxConcurrentCalls &&
			this.retryQueue.length > 0
		) {
			candidates.push(this.retryQueue[0].dueAt);
		}

		if (
			this.activeCalls < this.config.maxConcurrentCalls &&
			this.nextCustomerIndex < this.config.customerList.length &&
			!this.isWithinWorkingWindow(now)
		) {
			candidates.push(this.getNextWorkingWindowStart(now));
		}

		if (candidates.length === 0) {
			return null;
		}

		const nextTimestamp = Math.min(
			...candidates.filter((value) => value > now),
		);
		if (!Number.isFinite(nextTimestamp)) {
			return null;
		}

		return Math.max(0, nextTimestamp - now);
	}

	private recordUsage(startedAt: number, durationMs: number): void {
		let cursor = startedAt;
		let remainingMs = durationMs;

		while (remainingMs > 0) {
			const dayKey = this.getLocalDayKey(cursor);
			const nextMidnight = this.getNextLocalMidnight(cursor);
			const sliceMs = Math.min(remainingMs, nextMidnight - cursor);
			this.dailyUsageMs.set(
				dayKey,
				(this.dailyUsageMs.get(dayKey) ?? 0) + sliceMs,
			);
			cursor += sliceMs;
			remainingMs -= sliceMs;
		}
	}

	private getCurrentDayUsageMs(timestamp: number): number {
		return this.dailyUsageMs.get(this.getLocalDayKey(timestamp)) ?? 0;
	}

	private isWithinWorkingWindow(timestamp: number): boolean {
		const localParts = this.getLocalDateTimeParts(timestamp);
		const minuteOfDay = localParts.hour * 60 + localParts.minute;
		return (
			minuteOfDay >= this.startMinuteOfDay && minuteOfDay < this.endMinuteOfDay
		);
	}

	private getNextWorkingWindowStart(timestamp: number): number {
		const current = this.getLocalDateTimeParts(timestamp);
		const currentMinuteOfDay = current.hour * 60 + current.minute;

		if (currentMinuteOfDay < this.startMinuteOfDay) {
			return this.localDateTimeToEpoch(
				current.year,
				current.month,
				current.day,
				this.startMinuteOfDay,
			);
		}

		const tomorrow = this.addLocalDays(
			current.year,
			current.month,
			current.day,
			1,
		);
		return this.localDateTimeToEpoch(
			tomorrow.year,
			tomorrow.month,
			tomorrow.day,
			this.startMinuteOfDay,
		);
	}

	private getNextLocalMidnight(timestamp: number): number {
		const current = this.getLocalDateTimeParts(timestamp);
		const tomorrow = this.addLocalDays(
			current.year,
			current.month,
			current.day,
			1,
		);
		return this.localDateTimeToEpoch(
			tomorrow.year,
			tomorrow.month,
			tomorrow.day,
			0,
		);
	}

	private getLocalDayKey(timestamp: number): string {
		const parts = this.getLocalDateTimeParts(timestamp);
		return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
	}

	private getLocalDateTimeParts(timestamp: number): LocalDateTimeParts {
		const formattedParts = this.localDateTimeFormatter.formatToParts(timestamp);
		const values: Partial<LocalDateTimeParts> = {};

		for (const part of formattedParts) {
			if (part.type === "year") {
				values.year = Number(part.value);
			} else if (part.type === "month") {
				values.month = Number(part.value);
			} else if (part.type === "day") {
				values.day = Number(part.value);
			} else if (part.type === "hour") {
				values.hour = Number(part.value);
			} else if (part.type === "minute") {
				values.minute = Number(part.value);
			} else if (part.type === "second") {
				values.second = Number(part.value);
			}
		}

		return values as LocalDateTimeParts;
	}

	private localDateTimeToEpoch(
		year: number,
		month: number,
		day: number,
		minuteOfDay: number,
	): number {
		const hour = Math.floor(minuteOfDay / 60);
		const minute = minuteOfDay % 60;
		const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
		let guess = desiredUtcMs;

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const offsetMs = this.getTimeZoneOffsetMs(guess);
			const nextGuess = desiredUtcMs - offsetMs;
			if (nextGuess === guess) {
				break;
			}

			guess = nextGuess;
		}

		const targetTuple = [year, month, day, hour, minute];
		let candidate = guess;
		let candidateTuple = this.getComparableLocalTuple(candidate);

		if (this.compareTuples(candidateTuple, targetTuple) < 0) {
			while (this.compareTuples(candidateTuple, targetTuple) < 0) {
				candidate += MINUTE_MS;
				candidateTuple = this.getComparableLocalTuple(candidate);
			}
		} else if (this.compareTuples(candidateTuple, targetTuple) > 0) {
			while (
				this.compareTuples(
					this.getComparableLocalTuple(candidate - MINUTE_MS),
					targetTuple,
				) >= 0
			) {
				candidate -= MINUTE_MS;
			}
		}

		return candidate;
	}

	private getTimeZoneOffsetMs(timestamp: number): number {
		const parts = this.getLocalDateTimeParts(timestamp);
		const asUtc = Date.UTC(
			parts.year,
			parts.month - 1,
			parts.day,
			parts.hour,
			parts.minute,
			parts.second,
			0,
		);
		return asUtc - timestamp;
	}

	private getComparableLocalTuple(timestamp: number): number[] {
		const parts = this.getLocalDateTimeParts(timestamp);
		return [parts.year, parts.month, parts.day, parts.hour, parts.minute];
	}

	private addLocalDays(
		year: number,
		month: number,
		day: number,
		daysToAdd: number,
	): {
		year: number;
		month: number;
		day: number;
	} {
		const nextDate = new Date(Date.UTC(year, month - 1, day + daysToAdd));
		return {
			year: nextDate.getUTCFullYear(),
			month: nextDate.getUTCMonth() + 1,
			day: nextDate.getUTCDate(),
		};
	}

	private compareTuples(left: number[], right: number[]): number {
		for (
			let index = 0;
			index < Math.min(left.length, right.length);
			index += 1
		) {
			if (left[index] !== right[index]) {
				return left[index] - right[index];
			}
		}

		return left.length - right.length;
	}
}
