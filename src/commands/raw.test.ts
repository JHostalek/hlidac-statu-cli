import { describe, expect, test } from 'bun:test';
import { InvalidRawPair, parseRawQuery } from './raw.js';

describe('parseRawQuery', () => {
  test('parses key=value pairs and preserves equals signs inside values', () => {
    expect(parseRawQuery(['dotaz=elektřiny', 'q=a=b'])).toEqual({ dotaz: 'elektřiny', q: 'a=b' });
  });

  test('rejects missing separators and empty keys', () => {
    expect(() => parseRawQuery(['malformed'])).toThrow(InvalidRawPair);
    expect(() => parseRawQuery(['=value'])).toThrow(InvalidRawPair);
  });
});
