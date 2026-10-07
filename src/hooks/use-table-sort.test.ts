import { describe, expect, it } from 'vitest';
import { stableSort, type SortAccessor, type SortDirection } from './use-table-sort';

interface Row {
  id: string;
  value: string | number | null | undefined;
}

const accessors: Record<'value', SortAccessor<Row>> = { value: (row) => row.value };

function sortedIds(rows: readonly Row[], direction: SortDirection) {
  return stableSort(rows, { key: 'value', direction }, accessors).map((row) => row.id);
}

describe('stableSort', () => {
  it('sorts raw byte counts numerically in both directions', () => {
    const rows = [
      { id: 'large', value: 10_000_000 },
      { id: 'small', value: 900 },
      { id: 'medium', value: 2_000 },
      { id: 'zero', value: 0 },
    ];

    expect(sortedIds(rows, 'asc')).toEqual(['zero', 'small', 'medium', 'large']);
    expect(sortedIds(rows, 'desc')).toEqual(['large', 'medium', 'small', 'zero']);
  });

  it('sorts numeric timestamps chronologically rather than as text', () => {
    const rows = [
      { id: 'recent', value: Date.parse('2033-01-01T00:00:00Z') },
      { id: 'old', value: Date.parse('1998-01-01T00:00:00Z') },
      { id: 'middle', value: Date.parse('2005-01-01T00:00:00Z') },
    ];

    expect(sortedIds(rows, 'asc')).toEqual(['old', 'middle', 'recent']);
    expect(sortedIds(rows, 'desc')).toEqual(['recent', 'middle', 'old']);
  });

  it('compares Chinese strings naturally and preserves case-insensitive ties', () => {
    expect(
      sortedIds(
        [
          { id: 'ten', value: '节点10' },
          { id: 'two', value: '节点2' },
          { id: 'one', value: '节点1' },
        ],
        'asc',
      ),
    ).toEqual(['one', 'two', 'ten']);
    expect(
      sortedIds(
        [
          { id: 'upper', value: 'Proxy 2' },
          { id: 'ten', value: 'proxy 10' },
          { id: 'lower', value: 'proxy 2' },
        ],
        'asc',
      ),
    ).toEqual(['upper', 'lower', 'ten']);
  });

  it.each(['asc', 'desc'] as const)(
    'preserves source order for ties when sorting %s',
    (direction) => {
      const rows = [
        { id: 'third', value: 42 },
        { id: 'first', value: 42 },
        { id: 'second', value: 42 },
      ];

      expect(sortedIds(rows, direction)).toEqual(['third', 'first', 'second']);
    },
  );

  it.each(['asc', 'desc'] as const)(
    'keeps missing values and invalid numbers last when sorting %s',
    (direction) => {
      const rows: Row[] = [
        { id: 'null', value: null },
        { id: 'high', value: 12 },
        { id: 'undefined', value: undefined },
        { id: 'nan', value: Number.NaN },
        { id: 'zero', value: 0 },
        { id: 'infinity', value: Number.POSITIVE_INFINITY },
        { id: 'negative', value: -5 },
        { id: 'negative-infinity', value: Number.NEGATIVE_INFINITY },
      ];
      const validIds =
        direction === 'asc' ? ['negative', 'zero', 'high'] : ['high', 'zero', 'negative'];

      expect(sortedIds(rows, direction)).toEqual([
        ...validIds,
        'null',
        'undefined',
        'nan',
        'infinity',
        'negative-infinity',
      ]);
    },
  );

  it.each(['asc', 'desc'] as const)(
    'uses a stable ID tie-breaker independently of the %s direction',
    (direction) => {
      const rows = [
        { id: 'b', value: 1 },
        { id: 'a', value: 1 },
        { id: 'a', value: 1 },
      ];
      const result = stableSort(rows, { key: 'value', direction }, accessors, (a, b) =>
        a.id.localeCompare(b.id),
      );

      expect(result.map((row) => row.id)).toEqual(['a', 'a', 'b']);
      expect(result[0]).toBe(rows[1]);
      expect(result[1]).toBe(rows[2]);
    },
  );

  it('returns a new array without mutating the source or cloning its rows', () => {
    const first = Object.freeze({ id: 'first', value: 2 });
    const second = Object.freeze({ id: 'second', value: 1 });
    const rows = Object.freeze([first, second]);
    const result = stableSort(rows, { key: 'value', direction: 'asc' }, accessors);

    expect(rows).toEqual([first, second]);
    expect(result).not.toBe(rows);
    expect(result[0]).toBe(second);
    expect(result[1]).toBe(first);
  });
});
