import { describe, expect, it } from 'vitest';
import { isApiServerEnabled } from '../apiServerGate';

describe('isApiServerEnabled: the trading /api/* server defaults to disabled (phase7.txt §3)', () => {
  it('is false when API_ENABLED is absent', () => {
    expect(isApiServerEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is false when API_ENABLED is "false"', () => {
    expect(isApiServerEnabled({ API_ENABLED: 'false' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is false for any value other than the exact string "true" (e.g. "1", "TRUE")', () => {
    expect(isApiServerEnabled({ API_ENABLED: '1' } as NodeJS.ProcessEnv)).toBe(false);
    expect(isApiServerEnabled({ API_ENABLED: 'TRUE' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('is true only when API_ENABLED is exactly "true"', () => {
    expect(isApiServerEnabled({ API_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
