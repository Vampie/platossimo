# Tail-chase safety: why "can I reach my tail?" is the wrong test

Context: `src/move.ts` scores each candidate move with, among other things, a flood-fill
space check. The current working tree has a "naive fix" for the tail-chase problem:

```ts
space >= you.length || reachesTail ? 1 : 0,
```

where `reachesTail` is "is my current tail cell reachable at all from the candidate
cell, in one static BFS snapshot." A 40-game local A/B test showed this regresses win
rate. This doc investigates why, against primary sources, and gives a corrected,
same-complexity algorithm.

## 1. Official docs (docs.battlesnake.com)

The only official page on this is **[Useful Algorithms](https://docs.battlesnake.com/guides/useful-algorithms)**.
It covers exactly two algorithms, flood fill and A*, and nothing else:

- "Flood fill is an algorithm to determine the boundaries and size of an enclosed space."
- It frames flood fill purely as a **static** area check: "flood fill is a simple way to
  detect and avoid enclosed spaces that Battlesnakes may not be able to escape from."

There is no official page on Voronoi, on multi-step/time-aware flood fill, or on
tail-chasing specifically. The docs site's sidebar at that URL only lists Customizations,
Leaderboards, Tournaments, Engine Regions, Competitive Play, and Hosting Suggestions —
no "advanced AI" or "avoiding traps" guide exists on the official site. Voronoi-style
territory scoring (which this repo's `territoryAfter` already does) is a community
technique, not an official one; community write-ups that use it usually credit
A1k0n's 2010 Google AI Tron contest post-mortem as the origin of the idea.

**Conclusion: the official docs describe only the naive, single-snapshot flood fill.**
The refinement needed here (time-aware flood fill) is a community-developed technique,
not something docs.battlesnake.com teaches — see §3.

## 2. The rules engine: exact per-turn order of operations

Source: [`BattlesnakeOfficial/rules`](https://github.com/BattlesnakeOfficial/rules),
`main` branch, Go module.

### 2.1 Stage order

`standard.go` defines the standard ruleset's pipeline as an ordered list of named stages:

```go
var standardRulesetStages = []string{
	StageGameOverStandard,
	StageMovementStandard,
	StageStarvationStandard,
	StageHazardDamageStandard,
	StageFeedSnakesStandard,
	StageEliminationStandard,
}
```

(`pipeline.go`'s `NewPipelineFromRegistry` doc comment: stage execution order "will
correspond to the order the stage names are provided" — so this list *is* the turn
order.) So each turn runs, in this exact order: **game-over check → movement → starvation
→ hazard damage → feed snakes (growth) → elimination.**

This matters a lot for our purposes: **growth (tail duplication) happens after
movement but before elimination.** Elimination sees the post-growth board.

### 2.2 Movement is simultaneous, and the tail always drops unconditionally

`MoveSnakesStandard` computes every snake's new head from its *pre-move* body (e.g. for
"up", `newHead.Y = snake.Body[0].Y + 1`), and all snakes are moved from the same
pre-move snapshot — no snake's chosen direction is visible to another snake's move
resolution that same turn. Battlesnake moves are simultaneous, not sequential.

The body update always drops the last segment, with **no conditional for eating**:

```go
snake.Body = append([]Point{newHead}, snake.Body[:len(snake.Body)-1]...)
```

Growth is a separate, later stage. `FeedSnakesStandard` (via `growSnake`) duplicates the
current last segment when a snake's new head landed on food this turn:

```go
snake.Body = append(snake.Body, snake.Body[len(snake.Body)-1])
```

and resets health to max. So: **the tail cell is vacated unconditionally during
movement, and immediately re-occupied by a duplicate segment only if that snake ate —
and that re-occupation happens before elimination runs.** This is exactly the "stacked
tail" case `move.ts` already special-cases with its `slice(0, -1)` comment (line 24-27):
a body array whose last two coordinates are identical. The duplication is the rules
engine's actual mechanism for that, confirmed at the source.

### 2.3 Elimination rules

`EliminateSnakesStandard` and its helpers, evaluated against the post-movement,
post-growth board:

- **Out of bounds** (`snakeIsOutOfBounds`, `EliminatedByOutOfBounds`): any body point
  with `point.X < 0 || point.X >= boardWidth` (and the Y equivalent).
- **Starvation** (`snakeIsOutOfHealth`, `EliminatedByOutOfHealth`): `return s.Health <= 0`.
- **Self collision** (`snakeHasBodyCollided(snake, snake)`, `EliminatedBySelfCollision`):
  head checked against every body segment except index 0.
- **Collision with another snake's body** (same helper, `EliminatedByCollision`):
  checked against other snakes, longest first, attributing the elimination to that
  snake — the code comment is explicit: *"In multi-collision scenarios we want to
  always attribute elimination to the longest snake."*
- **Head-to-head** (`snakeHasLostHeadToHead`, `EliminatedByHeadToHeadCollision`), only
  when heads share a cell: `return len(s.Body) <= len(other.Body)`. Note the `<=`, not
  `<`: **on an exact length tie, both snakes satisfy "lost" against each other and both
  are eliminated** — it is not "shorter dies, longer survives," it's "only the strictly
  longer snake survives a tie." All collision eliminations are applied together after
  all checks run, so a tie removes both snakes simultaneously, not one-then-the-other.

None of this contradicts `move.ts`'s existing obstacle model, but it does confirm the
"just ate → stacked tail → tail doesn't vacate this turn" handling is correct and is
exactly what the engine does.

## 3. How established competitive bots actually solve this

The standard technique in the competitive community is **not** "can my flood fill reach
the tail cell" — it's a **time-respecting flood fill**: compute, per board cell, the
tick at which whatever body segment currently sits there will have vacated, then run
the BFS so a cell is only enterable once the search's elapsed-tick count reaches that
threshold. Two independently-written, well-known bots do exactly this:

### 3.1 `wrenger/snork` (Rust) — [`src/floodfill.rs`](https://github.com/wrenger/snork/blob/main/src/floodfill.rs)

Its own module doc states the idea directly: *"track the distance n from the heads and
ignoring snake bodies that are vanishing after n moves."* Concretely: every occupied
cell is stored as `FCell::Occupied { id, tail_dist }`, where `tail_dist` is that
segment's distance from its own tail. The reachability test (`owns`) is:

- Free cell → always passable.
- Own body cell → passable once `tail_dist + food <= distance` (the BFS's current
  step count) — `food` is how many of *your own* food pickups were collected along the
  path so far, which *delays* the vacate time, because a snake that eats doesn't
  shrink that tick.
- Enemy body cell → passable once `tail_dist <= distance` (with a comment flagging this
  as the case where "the enemy can be eaten" by moving into a cell it hasn't vacated
  from yet).

So snork's design explicitly builds in the eating edge case as a first-class,
per-path-dependent term, rather than a one-off special case.

### 3.2 `coreyja/battlesnake-rs` (Rust) — [`spread_from_head_tail_aware.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-rs/src/flood_fill/spread_from_head_tail_aware.rs)

Same idea, same name for it ("tail aware"). It precomputes `body_life[i]`, "the first
cycle on which cell `i` is enterable," with the comment: *"A tail is enterable on cycle
1 (it vacates this tick), the square in front of it on cycle 2, and so on."* During the
fill: `if body_life[cell] > cycle { continue }` — i.e. skip the neighbor if its vacate
tick hasn't arrived yet. Two details map directly onto our bug:

- **Stacked tail (just ate):** the doc comment says a stacked square "appears once per
  stack level," and the code takes the *later* vacate time for a given coordinate,
  which is explicitly called out as "what gives a double-stacked tail two ticks" to
  clear — i.e. +1 tick of delay per stacked segment, same mechanism as snork's `food`
  term and consistent with the rules-engine growth timing from §2.2.
- **Known, accepted approximation:** its module doc lists *"Growth is ignored. A snake
  that eats does not move its tail that tick, so vacate times are optimistic by one
  tick per food eaten along the way"* as a deliberate simplification for *other*
  snakes' future growth (unlike snork, it does not try to predict whether an opponent
  will eat food later on the path). This is a reasonable, budget-conscious choice we
  can copy.
- **No-wait frontiers:** *"Letting blocked frontiers retry would overstate reachable
  territory"* — if a frontier cell has no enterable neighbor on a given cycle, it dies
  rather than waiting for a later cycle, because the snake can only be in one place at
  a time; a cell that only opens up later is reached (if at all) by some *other* path at
  the right depth, not by sitting still.

A third write-up turned up by search but not independently verified against its full
source (fetch returned 403): a Devpost entry for a bot called **CyberSnake** describes
"we implemented time-aware flood fill so the snake's own tail is treated as temporarily
passable, preventing corner traps" (via `https://devpost.com/software/cybersnake`,
author's own description, seen only through a search snippet). It corroborates the same
technique by name but is not used as a code citation here since the source wasn't
directly readable.

**All primary sources found agree on one mechanism: compute a per-cell vacate tick,
then flood-fill with that as the obstacle test — not a binary "is my tail reachable."**

## 4. Why "can I reach my tail" produces false positives: a worked counterexample

`reachesTail` only proves *one specific cell* (wherever the tail sits in this one
static snapshot) is connected to the candidate cell by *some* path. It proves nothing
about whether that path is a sustainable loop. Concretely:

Snake of length 5, body head-to-tail: `H, b1, b2, b3, T`. Suppose the candidate move
leads into a **dead-end 3-cell corridor** `C → M → T`, where `T` happens to be the
snake's own current tail, `M` is one free cell, and `C` is the candidate cell — and
beyond `T` there is nothing (a wall). `space` here is 3 (`C`, `M`, `T`), which is
`< length` (5), so condition (a) correctly says "unsafe." `reachesTail` is `true` (`T`
is reachable via `C → M`), so the current `||` scores this move **safe**.

Walk it forward turn by turn (no other snakes needed — this is a purely self-inflicted
trap):

1. Move to `C`. Body: `[C, H, b1, b2, b3]` (old tail `T` vacates).
2. Move to `M`. Body: `[M, C, H, b1, b2]`.
3. Move to `T` (now empty, since it was vacated two turns ago). Body: `[T, M, C, H, b1]`.
4. From `T`, the only neighbor is `M` — which is now occupied by the snake's own body
   (`body[1]`). The corridor is a dead end, so there is no other neighbor. **Zero legal
   moves: the snake is trapped and dies**, exactly 3 turns after taking the "safe" move.

The flaw: in a true tail-chase loop, the cell *behind* the current tail (`b3`, which
becomes the next tail) is adjacent to `T` and continues the loop all the way back
around to near the head — so as `T` vacates, a *new* cell opens up right where you'd
need it, every single turn, indefinitely. In the dead-end corridor, the cell beyond `T`
is a wall, not more of your own retreating body — nothing ever opens up beyond what
`space` already counted. `reachesTail` cannot tell these two situations apart because it
only asks "is there a path to this one frozen coordinate," never "does this region
contain a cycle at least as long as my body." A straight corridor and a loop both
satisfy "path exists to the tail cell"; only a loop is actually safe. This is precisely
the gap the tail-aware flood fill in §3 closes: it doesn't check one cell's
reachability, it tracks a *vacate-time per cell* and lets the reachable-count keep
growing turn by turn as segments open up — a corridor's count plateaus at 3; a real
loop's count keeps climbing past `length`.

(The true positive from the bug report — a 2-cell pocket of "candidate cell + tail" —
is exactly the case where the cell right behind the tail, part of your own body, *is*
reachable and does continue a loop. The corridor example differs only in what's
*beyond* the tail: more of your own loop, vs. a wall. A plain reachability check cannot
see that difference; a vacate-time-respecting fill can, because it keeps expanding the
frontier as more segments' vacate ticks pass, rather than stopping once it's touched
the tail coordinate once.)

## 5. The user's gating question: answered directly

**Claim to check:** "condition (b) should only ever be consulted when condition (a)
already fails — and with plain boolean OR this is already implicitly true."

**Confirmed, exactly as stated, no code change needed for this specific point.**
`a || b` is, by definition of boolean OR, only sensitive to `b`'s value when `a` is
`false`; when `a` is `true` the expression is `true` regardless of `b`. There is nothing
to fix here — the short-circuit/gating semantics the user describes are already exactly
what `||` provides, and this is true independent of JS's left-to-right evaluation order
(which only affects whether `b` is *computed* at all, not what it *means* once it is).

**But this was never the regression's cause.** The bug is not about *when* `b` is
consulted — it's that `b` itself (plain "can I reach my tail cell") is not a valid test
of "this is a safe infinite tail-chase," regardless of when you ask it (see §4's
counterexample, which is unsafe no matter how it's gated). Tightening the gating
changes nothing; the predicate itself has to be replaced. The fix in §6 doesn't need an
`a || b` at all — a single corrected check subsumes both terms.

## 6. Corrected algorithm

Replace the binary blocked-cell model with a per-cell **vacate tick**, and do one
time-respecting BFS whose result directly replaces both `space >= length` and
`reachesTail`:

```ts
// vacate[cell] = the tick (moves from "now") at which the segment currently
// occupying it will have moved on. 0 = already free. For a body of length n,
// index 0 = head ... index n-1 = tail: the tail needs 1 more tick to clear, the
// segment ahead of it 2, etc. A stacked tail (snake just ate: the last two body
// coordinates are identical) naturally gets the LARGER of the two ticks, because
// we keep the max — which is exactly the "+1 tick to clear" rule snork/battlesnake-rs
// both use for growth, with no separate special case needed.
function vacateTimes(board: GameState["board"], width: number, height: number, key: (x: number, y: number) => number): Uint16Array {
  const vacate = new Uint16Array(width * height); // default 0 = free
  for (const s of board.snakes) {
    const n = s.body.length;
    for (let i = 0; i < n; i++) {
      const k = key(s.body[i].x, s.body[i].y);
      const ticksToClear = n - i;
      if (ticksToClear > vacate[k]) vacate[k] = ticksToClear;
    }
  }
  return vacate;
}

// Time-respecting BFS from the candidate cell (which is where you'll be after
// THIS move, i.e. 1 tick from now). A neighbor is enterable once the number of
// ticks elapsed to reach it is >= that cell's vacate time. Early-exits once the
// count already proves safety, since all we need is "count >= length".
function safeSpace(x: number, y: number, vacate: Uint16Array, width: number, height: number, inBounds: (x: number, y: number) => boolean, key: (x: number, y: number) => number, length: number): number {
  const seen = new Int16Array(width * height).fill(-1);
  const startKey = key(x, y);
  seen[startKey] = 1; // this move is tick 1
  const queue = [startKey];
  let count = 0;
  for (let qi = 0; qi < queue.length; qi++) {
    count++;
    if (count >= length) return count; // already proven safe, stop early
    const k = queue[qi];
    const tick = seen[k];
    const cx = k % width, cy = (k / width) | 0;
    for (const [, dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy, nk = key(nx, ny);
      if (inBounds(nx, ny) && seen[nk] === -1 && tick + 1 >= vacate[nk]) {
        seen[nk] = tick + 1;
        queue.push(nk);
      }
    }
  }
  return count;
}

// Per candidate move:
const vacate = vacateTimes(board, width, height, key); // once per chooseMove call
// ...
const safe = safeSpace(x, y, vacate, width, height, inBounds, key, you.length) >= you.length;
// score[0] = safe ? 1 : 0   — replaces `space >= you.length || reachesTail`
```

This is a strict generalization of the existing code, not an addition to it: when every
reachable cell's vacate time is 0 or 1 (no multi-segment retreat matters within the
region), it degenerates to exactly today's plain flood fill. It also keeps the existing
`space` value (the old plain BFS) available wherever the rest of `move.ts` uses raw
space as a tie-breaker (`score[4]`) — `safeSpace`'s count is a *better* space estimate
for that too, since it won't under-count cells that open up as your own tail retreats;
it would be reasonable to just replace `distances()`'s obstacle BFS with this one
everywhere it's used for "how much room do I have," not only for the safety gate.

### 6.1 Complexity / ~10ms budget

This is the same asymptotic cost as the current `distances()` BFS: a single pass over
at most `width * height` cells (121 on the standard board) with O(1) extra work per
cell (one integer comparison against `vacate[]` instead of one `Set.has` check) and a
cheap O(total snake length) precompute (sum of all snakes' lengths — well under 100,
typically) done once per `chooseMove` call, not once per candidate move. There is no new
search depth, no backtracking, no repeated BFS passes — it's the same flood fill, with a
richer per-cell predicate. Given the current code already runs on the order of a dozen+
BFS passes per move (one per candidate direction, plus the 2-ply duel lookahead's
several more), and that already fits the ~10ms Cloudflare Workers budget, swapping the
obstacle test for a vacate-time comparison does not change the operation count enough
to matter — it's a few hundred extra integer comparisons across the whole `chooseMove`
call, not a new order of magnitude. The early-exit (`count >= length`) typically
terminates well before visiting all 121 cells whenever the move is actually safe,
which is the common case.

### 6.2 The "just ate" case, explicitly

Handled by the vacate-time formula itself, not a special case: `vacateTimes` takes the
*max* tick over all segments at a coordinate. When a snake has just eaten, its body
array's last two coordinates are identical (confirmed against the rules engine in
§2.2: `growSnake` duplicates the last segment after movement, before elimination, so
the state you're handed next turn already reflects this). Those two duplicate indices
produce two different `ticksToClear` values (`n - (n-1) = 1` and `n - (n-2) = 2`); taking
the max assigns that cell `vacate = 2`, i.e. it takes one extra tick to clear, exactly
matching the rules engine's actual growth timing and exactly matching the "two ticks to
clear a double-stacked tail" rule both `snork` and `battlesnake-rs` implement (§3). No
`if (justAte)` branch is needed anywhere.

What is *not* handled, by design, matching `battlesnake-rs`'s documented approximation
(§3.2): **future** food pickups along the BFS path (yours or an opponent's) are ignored
— we don't delay a cell's vacate time just because the path to it crosses a food
square. `snork` does model this for your own snake (the `food` term added to
`tail_dist`), which would be a one-line addition (track food crossed so far in the BFS
and add it when computing `tick + 1 >= vacate[nk]` for your own body's cells) if it
turns out to matter in practice. Given the ~10ms budget and that this is already a
second-order refinement of an already-approximate heuristic, start without it.

```
shortcut: future food pickups during the BFS walk are not modeled, so a snake that
will eat along its own retreat path is treated as vacating 1 tick earlier than it
really will. Upgrade by tracking crossed-food count per path and adding it to the
vacate-time comparison for your own body's cells (see snork's `food` term), if this
is ever shown to matter in an A/B test.
```

## Sources

- [docs.battlesnake.com/guides/useful-algorithms](https://docs.battlesnake.com/guides/useful-algorithms) — official flood fill / A* guide (static flood fill only, no Voronoi/traps page exists on the official site)
- [github.com/BattlesnakeOfficial/rules](https://github.com/BattlesnakeOfficial/rules) — rules engine source
  - [`standard.go`](https://github.com/BattlesnakeOfficial/rules/blob/main/standard.go) — `MoveSnakesStandard`, `growSnake`/`FeedSnakesStandard`, `EliminateSnakesStandard`, `snakeIsOutOfBounds`, `snakeIsOutOfHealth`, `snakeHasBodyCollided`, `snakeHasLostHeadToHead`, `standardRulesetStages`
  - [`pipeline.go`](https://github.com/BattlesnakeOfficial/rules/blob/main/pipeline.go) — stage ordering contract (`NewPipelineFromRegistry`)
- [github.com/wrenger/snork](https://github.com/wrenger/snork) — [`src/floodfill.rs`](https://github.com/wrenger/snork/blob/main/src/floodfill.rs): `FCell::Occupied{id, tail_dist}`, `owns()`, time-aware flood fill
- [github.com/coreyja/battlesnake-rs](https://github.com/coreyja/battlesnake-rs) — [`battlesnake-rs/src/flood_fill/spread_from_head_tail_aware.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-rs/src/flood_fill/spread_from_head_tail_aware.rs): `body_life`/"enterable cycle", stacked-tail and growth-approximation comments
- [devpost.com/software/cybersnake](https://devpost.com/software/cybersnake) — author's own description of a "time-aware flood fill" treating the tail as temporarily passable (corroborating, seen via search snippet only — direct fetch returned HTTP 403, so not quoted as a code source)
