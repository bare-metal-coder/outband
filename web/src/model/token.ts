/** API tokens as the UI shows them (wire shapes are mapped in src/api/adapt.ts). */

export type Scope = 'read' | 'power_on' | 'power_off' | 'console' | 'identity' | 'audit';

export const SCOPES: { id: Scope; label: string; detail: string }[] = [
  { id: 'read', label: 'Read', detail: 'Groups, devices, events and the live stream.' },
  { id: 'power_on', label: 'Power on', detail: 'Power on and wake.' },
  { id: 'power_off', label: 'Power off', detail: 'Shut down, restart, hard power off, reset, cycle and sleep.' },
  { id: 'console', label: 'Console', detail: 'Text consoles (Serial-over-LAN). Needs a group limit.' },
  { id: 'identity', label: 'Identity', detail: 'Your email and site rights in the session.' },
  { id: 'audit', label: 'Audit', detail: 'Real user and token names in events.' },
];

export type TokenStatus = 'active' | 'expired' | 'revoked';

export interface ApiToken {
  id: string;
  name: string;
  /** First 8 characters of the secret. */
  prefix: string;
  scopes: string[];
  /** `null` = every group the owner can see. */
  groupIds: string[] | null;
  allowedIps: string[] | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function tokenStatus(t: ApiToken, now = Date.now()): TokenStatus {
  if (t.revokedAt) return 'revoked';
  return Date.parse(t.expiresAt) <= now ? 'expired' : 'active';
}

/** The `device_power` profile: exactly read + power_on + power_off. */
export const DEVICE_POWER_SCOPES: Scope[] = ['read', 'power_on', 'power_off'];

/**
 * Longest lifetime the server allows: 30 days with `console`, 90 with a power
 * or `audit` scope, else 365 (spec, "Token lifetime limits").
 */
export function maxDays(scopes: readonly string[]): number {
  if (scopes.includes('console')) return 30;
  if (scopes.includes('power_on') || scopes.includes('power_off') || scopes.includes('audit')) return 90;
  return 365;
}

export interface TokenForm {
  name: string;
  mode: 'profile' | 'custom';
  scopes: Scope[];
  groups: string[];
  days: number;
}

export function formScopes(f: TokenForm): Scope[] {
  return f.mode === 'profile' ? DEVICE_POWER_SCOPES : f.scopes;
}

/** Client-side checks that mirror the server's, so the common mistakes show before a round trip. */
export function validateTokenForm(f: TokenForm): string | null {
  const name = f.name.trim();
  if (!name) return 'Give the token a name.';
  if (name.length > 64 || !/^[\x20-\x7E]+$/.test(name)) return 'Use up to 64 plain characters for the name.';
  const scopes = formScopes(f);
  if (!scopes.length) return 'Pick at least one scope.';
  if (scopes.includes('console') && !f.groups.length) return 'A console token must be limited to at least one group.';
  const max = maxDays(scopes);
  if (!Number.isInteger(f.days) || f.days < 1) return 'Expiry must be a whole number of days.';
  if (f.days > max) return `With these scopes a token lasts at most ${max} days.`;
  return null;
}

/** Whether a token with these scopes needs step-up (anything beyond read and identity). */
export function needsStepUp(scopes: readonly string[]): boolean {
  return scopes.some((s) => s !== 'read' && s !== 'identity');
}

export function createBody(f: TokenForm): Record<string, unknown> {
  const body: Record<string, unknown> = { name: f.name.trim(), expires_in_days: f.days };
  if (f.mode === 'profile') body.profile = 'device_power';
  else body.scopes = f.scopes;
  if (f.groups.length) body.groups = f.groups;
  return body;
}
