const BASE_THUMBNAIL_CELL_WIDTH = 168;
const MIN_TIMELINE_WIDTH = 720;

export function getTimelineCellWidth(zoom: number) {
  return Math.round(BASE_THUMBNAIL_CELL_WIDTH * Math.min(Math.max(zoom, 1), 2.5));
}

export function getVirtualTimelineWidth(count: number, zoom: number, minimumWidth = MIN_TIMELINE_WIDTH) {
  if (count <= 0) {
    return minimumWidth;
  }

  return Math.max(minimumWidth, count * getTimelineCellWidth(zoom));
}

export function summarizeVirtualTimeline(totalItems: number, renderedItems: number) {
  return {
    renderedItems: Math.max(0, renderedItems),
    totalItems: Math.max(0, totalItems),
    virtualized: totalItems > 0 && renderedItems < totalItems,
  };
}
