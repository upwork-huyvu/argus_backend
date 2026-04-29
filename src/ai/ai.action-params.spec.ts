import { AiService } from './ai.service';

/**
 * Pin the action-param validator. The runtime prompt
 * (`prompts/ai-chat.runtime.prompt.txt`) declares ranges per action; this
 * spec is the source-of-truth that the BE actually enforces those ranges
 * regardless of what the LLM returns.
 */
describe('AiService.validateActionParams', () => {
  // Reach the private method via the prototype — pure function, no
  // dependencies needed.
  const validate = (
    AiService.prototype as unknown as {
      validateActionParams: (a: { name: string; params: Record<string, unknown> }) => unknown;
    }
  ).validateActionParams.bind({});

  describe('zero-param actions', () => {
    it.each([
      'TAKEOFF',
      'LAND',
      'EMERGENCY_LAND',
      'RETURN_HOME',
      'HOVER',
      'FOLLOW_ME',
    ])('%s normalises to {}', (name) => {
      expect(validate({ name, params: { junk: 1 } })).toEqual({
        name,
        params: {},
      });
    });
  });

  describe('GO_TO_WAYPOINT', () => {
    it('accepts valid lat/lon', () => {
      expect(
        validate({
          name: 'GO_TO_WAYPOINT',
          params: { latitude: 10.7, longitude: 106.7 },
        }),
      ).toEqual({
        name: 'GO_TO_WAYPOINT',
        params: { latitude: 10.7, longitude: 106.7 },
      });
    });
    it('coerces numeric strings', () => {
      expect(
        validate({
          name: 'GO_TO_WAYPOINT',
          params: { latitude: '10.7', longitude: '106.7' },
        }),
      ).toEqual({
        name: 'GO_TO_WAYPOINT',
        params: { latitude: 10.7, longitude: 106.7 },
      });
    });
    it('keeps optional altitude when in range', () => {
      expect(
        validate({
          name: 'GO_TO_WAYPOINT',
          params: { latitude: 0, longitude: 0, altitude_m: 30 },
        }),
      ).toEqual({
        name: 'GO_TO_WAYPOINT',
        params: { latitude: 0, longitude: 0, altitude_m: 30 },
      });
    });
    it('rejects missing lat/lon', () => {
      expect(typeof validate({ name: 'GO_TO_WAYPOINT', params: {} })).toBe('string');
    });
    it('rejects out-of-range lat/lon', () => {
      expect(typeof validate({ name: 'GO_TO_WAYPOINT', params: { latitude: 200, longitude: 0 } })).toBe('string');
      expect(typeof validate({ name: 'GO_TO_WAYPOINT', params: { latitude: 0, longitude: 999 } })).toBe('string');
    });
    it('rejects altitude over 500 m', () => {
      expect(typeof validate({ name: 'GO_TO_WAYPOINT', params: { latitude: 0, longitude: 0, altitude_m: 9999 } })).toBe('string');
    });
  });

  describe('ASCEND', () => {
    it('accepts valid positive delta', () => {
      expect(validate({ name: 'ASCEND', params: { delta_m: 5 } })).toEqual({
        name: 'ASCEND',
        params: { delta_m: 5 },
      });
    });
    it('accepts negative delta (descend)', () => {
      expect(validate({ name: 'ASCEND', params: { delta_m: -3 } })).toEqual({
        name: 'ASCEND',
        params: { delta_m: -3 },
      });
    });
    it('accepts max_speed_ms in range', () => {
      expect(
        validate({ name: 'ASCEND', params: { delta_m: 5, max_speed_ms: 1.5 } }),
      ).toEqual({
        name: 'ASCEND',
        params: { delta_m: 5, max_speed_ms: 1.5 },
      });
    });
    it('rejects zero or missing delta_m', () => {
      expect(typeof validate({ name: 'ASCEND', params: {} })).toBe('string');
      expect(typeof validate({ name: 'ASCEND', params: { delta_m: 0 } })).toBe('string');
    });
    it('rejects delta beyond ±50 m', () => {
      expect(typeof validate({ name: 'ASCEND', params: { delta_m: 80 } })).toBe('string');
      expect(typeof validate({ name: 'ASCEND', params: { delta_m: -80 } })).toBe('string');
    });
    it('rejects max_speed_ms outside [0.2, 4]', () => {
      expect(typeof validate({ name: 'ASCEND', params: { delta_m: 5, max_speed_ms: 0.05 } })).toBe('string');
      expect(typeof validate({ name: 'ASCEND', params: { delta_m: 5, max_speed_ms: 9 } })).toBe('string');
    });
  });

  describe('ORBIT', () => {
    it('accepts no params (all defaults)', () => {
      expect(validate({ name: 'ORBIT', params: {} })).toEqual({
        name: 'ORBIT',
        params: {},
      });
    });
    it('keeps clockwise=false', () => {
      const out = validate({ name: 'ORBIT', params: { clockwise: false } });
      expect(out).toEqual({ name: 'ORBIT', params: { clockwise: false } });
    });
    it('rejects radius outside [3, 200]', () => {
      expect(typeof validate({ name: 'ORBIT', params: { radius_m: 1 } })).toBe('string');
      expect(typeof validate({ name: 'ORBIT', params: { radius_m: 9999 } })).toBe('string');
    });
    it('rejects revolutions outside [0.25, 10]', () => {
      expect(typeof validate({ name: 'ORBIT', params: { revolutions: 0.1 } })).toBe('string');
      expect(typeof validate({ name: 'ORBIT', params: { revolutions: 50 } })).toBe('string');
    });
    it('rejects angular_velocity outside [3, 60]', () => {
      expect(typeof validate({ name: 'ORBIT', params: { angular_velocity_deg_s: 1 } })).toBe('string');
      expect(typeof validate({ name: 'ORBIT', params: { angular_velocity_deg_s: 200 } })).toBe('string');
    });
    it('rejects only-latitude (lat & lon must come together)', () => {
      expect(typeof validate({ name: 'ORBIT', params: { latitude: 10 } })).toBe('string');
      expect(typeof validate({ name: 'ORBIT', params: { longitude: 10 } })).toBe('string');
    });
    it('accepts both lat and lon together', () => {
      expect(
        validate({ name: 'ORBIT', params: { latitude: 10.5, longitude: 106.5 } }),
      ).toEqual({
        name: 'ORBIT',
        params: { latitude: 10.5, longitude: 106.5 },
      });
    });
  });

  describe('RUN_MISSION', () => {
    it('accepts non-empty mission_id', () => {
      expect(
        validate({ name: 'RUN_MISSION', params: { mission_id: 'perimeter' } }),
      ).toEqual({
        name: 'RUN_MISSION',
        params: { mission_id: 'perimeter' },
      });
    });
    it('rejects missing or empty mission_id', () => {
      expect(typeof validate({ name: 'RUN_MISSION', params: {} })).toBe('string');
      expect(typeof validate({ name: 'RUN_MISSION', params: { mission_id: '   ' } })).toBe('string');
    });
  });

  describe('Unknown action', () => {
    it('rejects names not in the catalog', () => {
      expect(typeof validate({ name: 'WARP_DRIVE', params: {} })).toBe('string');
    });
  });
});
