import type { z } from 'zod';

export type IssuePath = Array<string | number>;

export function rejectDuplicateIds<Value>(
  values: readonly Value[],
  getId: (value: Value) => string,
  path: IssuePath,
  context: z.RefinementCtx,
): void {
  const firstIndexById = new Map<string, number>();

  values.forEach((value, index) => {
    const id = getId(value);
    if (firstIndexById.has(id)) {
      context.addIssue({
        code: 'custom',
        path: [...path, index, 'id'],
        message: `Duplicate id: ${id}`,
      });
      return;
    }
    firstIndexById.set(id, index);
  });
}

export function isChronologicallySorted(
  values: ReadonlyArray<{ createdAt: string; id: string }>,
): boolean {
  return values.every((value, index) => {
    if (index === 0) {
      return true;
    }
    const previous = values[index - 1];
    if (previous === undefined) {
      return true;
    }
    const dateComparison = previous.createdAt.localeCompare(value.createdAt);
    return dateComparison < 0 || (dateComparison === 0 && previous.id.localeCompare(value.id) <= 0);
  });
}
