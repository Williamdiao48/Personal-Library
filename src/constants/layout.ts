// Shared card-grid geometry for the Library and Collection views (audit RED-1).
// Both render the same auto-fill ItemCard grid, so the gap + minimum column
// width must stay in lockstep — keeping them here means one edit, not two. Must
// match the CSS grid (`repeat(auto-fill, minmax(MIN_COL_WIDTH, 1fr))` + gap).
export const GRID_GAP = 20 // px between cards
export const MIN_COL_WIDTH = 160 // px minimum column width
