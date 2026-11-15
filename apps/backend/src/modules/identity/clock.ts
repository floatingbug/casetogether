export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AUTH_SESSION_TTL_SECONDS = AUTH_SESSION_TTL_MS / 1000;
