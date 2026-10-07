import { useCallback, useMemo, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  direction: SortDirection;
}

export type SortAccessor<T> = (row: T) => string | number | null | undefined;

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function isMissing(value: string | number | null | undefined): boolean {
  return value == null || (typeof value === 'number' && !Number.isFinite(value));
}

export function stableSort<T, K extends string>(
  rows: readonly T[],
  sort: SortState<K>,
  accessors: Record<K, SortAccessor<T>>,
  tieBreaker?: (a: T, b: T) => number,
): T[] {
  const accessor = accessors[sort.key];
  const direction = sort.direction === 'asc' ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index, value: accessor(row) }))
    .sort((a, b) => {
      const aMissing = isMissing(a.value);
      const bMissing = isMissing(b.value);

      // Missing values stay last even when the primary sort is descending.
      if (aMissing !== bMissing) return aMissing ? 1 : -1;

      if (!aMissing && !bMissing) {
        const comparison =
          typeof a.value === 'number' && typeof b.value === 'number'
            ? a.value < b.value
              ? -1
              : a.value > b.value
                ? 1
                : 0
            : collator.compare(String(a.value), String(b.value));
        if (comparison !== 0) return comparison * direction;
      }

      // Keep equal values in a consistent order across direction changes and refreshes.
      const tie = tieBreaker?.(a.row, b.row) ?? 0;
      return Number.isFinite(tie) && tie !== 0 ? tie : a.index - b.index;
    })
    .map(({ row }) => row);
}

export function useTableSort<T, K extends string>(
  rows: readonly T[],
  accessors: Record<K, SortAccessor<T>>,
  initialSort: SortState<K>,
  tieBreaker?: (a: T, b: T) => number,
) {
  const [sort, setSort] = useState<SortState<K>>(initialSort);
  const sortedRows = useMemo(
    () => stableSort(rows, sort, accessors, tieBreaker),
    [rows, sort, accessors, tieBreaker],
  );
  const toggleSort = useCallback((key: K) => {
    setSort((previous) => ({
      key,
      direction: previous.key === key && previous.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, []);
  const ariaSort = useCallback(
    (key: K): 'ascending' | 'descending' | 'none' =>
      sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none',
    [sort],
  );

  return { sortedRows, sort, toggleSort, ariaSort };
}
