/**
 * Match-result reporting to the platform's gamer-profile ingestion API.
 *
 * After a room finishes a match, the server — the only authority on
 * outcomes — reports every seated participant once, signed with the
 * shared REALTIME_TOKEN_SECRET. The platform deduplicates on
 * (roomId, userId), so retries are harmless; NOT reporting is the only
 * unrecoverable mistake, hence the bounded retries below.
 *
 * Reporting is fire-and-forget by design: a platform outage must never
 * break or delay a live match. Failures are logged, not thrown.
 */

const DEFAULT_PLATFORM_URL = "http://localhost:3000";
const INGESTION_TIMEOUT_MS = 5_000;
const MAX_ATTEMPTS = 3;

export interface ParticipantReport {
    userId: string;
    /** "win" | "loss" | "draw" — decided by the room, never by the player. */
    outcome: "win" | "loss" | "draw";
    /** Seat index at match end. */
    seat: number;
    /** Server-measured match duration, in seconds. */
    durationSeconds: number;
}

export interface MatchReport {
    gameId: string;
    roomId: string;
    participants: ParticipantReport[];
}

/** Stable HMAC over the exact bytes that are sent. */
async function sign(body: string): Promise<string> {
    const { createHmac } = await import("node:crypto");
    return createHmac("sha256", getSecret()).update(body, "utf8").digest("hex");
}

function getSecret(): string {
    const secret = process.env.REALTIME_TOKEN_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error(
            "REALTIME_TOKEN_SECRET is missing — cannot sign match reports",
        );
    }
    return secret;
}

function platformBaseUrl(): string {
    return (process.env.PLATFORM_URL ?? DEFAULT_PLATFORM_URL).replace(
        /\/$/,
        "",
    );
}

/**
 * Report a finished match. Resolves when the platform acknowledged (or
 * after the last attempt failed); never rejects, never throws.
 */
export async function reportMatchFinished(report: MatchReport): Promise<void> {
    const body = JSON.stringify({
        gameId: report.gameId,
        roomId: report.roomId,
        participants: report.participants,
    });

    let signature: string;
    try {
        signature = await sign(body);
    } catch (error) {
        console.error("[profile] not reporting match:", error);
        return;
    }

    const url = `${platformBaseUrl()}/api/profile/match-results`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-realtime-signature": `sha256=${signature}`,
                },
                body,
                signal: AbortSignal.timeout(INGESTION_TIMEOUT_MS),
            });

            if (response.ok) return; // recorded (or a benign duplicate)

            // 4xx (other than 429) will never get better by retrying.
            if (response.status >= 400 && response.status < 500 && response.status !== 429) {
                console.error(
                    `[profile] ingestion rejected the report (HTTP ${response.status})`,
                );
                return;
            }

            console.warn(
                `[profile] ingestion attempt ${attempt} failed (HTTP ${response.status})`,
            );
        } catch (error) {
            console.warn(
                `[profile] ingestion attempt ${attempt} failed:`,
                error,
            );
        }

        if (attempt < MAX_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
        }
    }
}
