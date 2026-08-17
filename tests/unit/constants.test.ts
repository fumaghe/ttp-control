import { describe, expect, it } from 'vitest';

import { APP_BANNER, APP_NAME, APP_VERSION } from '../../src/utils/constants.js';

describe('constants', () => {
  it('exposes the application name', () => {
    expect(APP_NAME).toBe('TTP Control');
  });

  it('uses a semver-shaped version', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('builds the banner from name and version', () => {
    expect(APP_BANNER).toBe(`${APP_NAME} v${APP_VERSION}`);
  });
});
