import type { ResourceRecord, PaginatedResponse } from './types.js';

const DEFAULT_LIMIT = 20;

/**
 * Handles cursor-based pagination for list responses.
 */
export class Paginator {
  paginate(
    records: ResourceRecord[],
    options: { limit?: number; after?: string } = {}
  ): PaginatedResponse {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const after = options.after;

    let startIndex = 0;

    if (after) {
      // Find the index of the record with the given cursor
      const cursorIndex = records.findIndex((r) => r.id === after);
      if (cursorIndex !== -1) {
        startIndex = cursorIndex + 1;
      }
    }

    const pageRecords = records.slice(startIndex, startIndex + limit);
    const hasNextPage = startIndex + limit < records.length;
    const lastRecord = pageRecords[pageRecords.length - 1];

    return {
      data: pageRecords,
      page_info: {
        end_cursor: lastRecord ? (lastRecord.id as string) : null,
        has_next_page: hasNextPage,
      },
    };
  }
}
