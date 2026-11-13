export type Coord = { x: number; y: number };
export type Snake = { id: string; health: number; length: number; head: Coord; body: Coord[] };
export type GameState = {
  board: { width: number; height: number; food: Coord[]; snakes: Snake[] };
  you: Snake;
};
export type Move = "up" | "down" | "left" | "right";

const DIRS: [Move, number, number][] = [
  ["up", 0, 1],
  ["down", 0, -1],
  ["left", -1, 0],
  ["right", 1, 0],
];

export function chooseMove({ board, you }: GameState): Move {
  const { width, height } = board;
  const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;
  const key = (x: number, y: number) => y * width + x;

  // Cells still occupied next turn. Tails move away, except a stacked tail (just ate):
  // slice(0, -1) keeps that one because the segment before it sits on the same cell.
  const blocked = new Set<number>();
  for (const s of board.snakes) for (const c of s.body.slice(0, -1)) blocked.add(key(c.x, c.y));

  // Cells where a head-on collision would kill us: next to an equal or longer opponent's head.
  const risky = new Set<number>();
  for (const s of board.snakes) {
    if (s.id === you.id || s.length < you.length) continue;
    for (const [, dx, dy] of DIRS) {
      if (inBounds(s.head.x + dx, s.head.y + dy)) risky.add(key(s.head.x + dx, s.head.y + dy));
    }
  }

  // Flood fill: how many free cells can we reach from (x, y)?
  const room = (x: number, y: number) => {
    const seen = new Set([key(x, y)]);
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      for (const [, dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
        if (inBounds(nx, ny) && !blocked.has(k) && !seen.has(k)) {
          seen.add(k);
          stack.push([nx, ny]);
        }
      }
    }
    return seen.size;
  };

  const longestOther = Math.max(0, ...board.snakes.filter((s) => s.id !== you.id).map((s) => s.length));
  const hungry = you.health < 40 || you.length <= longestOther;

  // Each option gets a score tuple, compared left to right: higher wins.
  const options: { move: Move; score: number[] }[] = [];
  for (const [move, dx, dy] of DIRS) {
    const x = you.head.x + dx, y = you.head.y + dy;
    if (!inBounds(x, y) || blocked.has(key(x, y))) continue;
    const space = room(x, y);
    const foodDist = Math.min(...board.food.map((f) => Math.abs(f.x - x) + Math.abs(f.y - y)));
    options.push({
      move,
      score: [space >= you.length ? 1 : 0, risky.has(key(x, y)) ? 0 : 1, hungry ? -foodDist : 0, space],
    });
  }
  if (!options.length) return "up"; // every move is fatal, so any answer will do

  options.sort((a, b) => {
    for (let i = 0; i < a.score.length; i++) if (a.score[i] !== b.score[i]) return b.score[i] - a.score[i];
    return 0;
  });
  return options[0].move;
}
