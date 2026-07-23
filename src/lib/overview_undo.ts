// Bridges Ctrl/Cmd+Z (captured once, at the card level) to whichever
// overview row most recently made a change - each row registers its own
// undo function here when it edits a slot.
let lastUndo: (() => void) | null = null;

export const setLastOverviewUndo = (fn: (() => void) | null) => {
  lastUndo = fn;
};

export const consumeLastOverviewUndo = () => {
  const fn = lastUndo;
  lastUndo = null;
  return fn;
};
