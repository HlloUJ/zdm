import type { PageInfo, PrimaryTableCol } from 'tdesign-vue-next';

// TDesign numbers visible rows and accounts for its own pagination.
// Lists with a separate pager pass the pagination used to slice their rows.
export function listRowNumberColumn(externalPage?: Pick<PageInfo, 'current' | 'pageSize'>): PrimaryTableCol {
  const column = { colKey: 'serial-number', title: '序号', width: 80, align: 'left' } as const;
  if (!externalPage) return column;

  const offset = (externalPage.current - 1) * externalPage.pageSize;
  return { ...column, colKey: 'rowNumber', cell: (_h, { rowIndex }) => String(offset + rowIndex + 1) };
}
