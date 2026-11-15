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

## 7. Opponent-contested space: the single-file-corridor trap

### 7.1 The bug, restated, and a minimal counterexample

As reported this session (two replay frames, turn 61 and turn 64, not independently
re-verified against the raw replay JSON here — treated as the user's own first-hand
account of their bot's game): at turn 61 Platossimo (length 9) had a candidate move
("left") adjacent to a shorter opponent's head, so it got the attack bonus (`prey`),
*and* its `safeSpace` count came out to exactly 9 — `>= length`, so the existing §6 gate
scored it "safe." Taking it committed Platossimo to a corridor with branching factor 1
(exactly one legal move) for two more turns, then zero legal moves on turn 64 — dead,
three turns after the "safe" move. The reported mechanism: part of that count-of-9 ran
through a cell that was, at that snapshot, Platossimo's *own* vacating tail (correctly
counted as "will be free soon" by §6's `vacateAt`) — but the fleeing opponent, retreating
straight away from the attack, walked its own body into that exact cell (and a
neighboring one) two-to-three ticks later, before Platossimo's single-file path could
get there first.

A clean, minimal version of the same mechanism, in the same labeled-cell style as §4's
counterexample (no board coordinates needed, so there's no grid to get subtly
inconsistent):

Our snake, length 5, body head-to-tail: `H, b1, b2, b3, T` — same shape as §4. This time
the dead end beyond `T` isn't a wall; it's one more free cell, `F`, reached through a
single-file side corridor `C → M → T → F` (branching factor 1 the whole way — no
alternate cell at any step). Just beyond `F`, the opponent's head `Oh` sits one cell
away, and the opponent's own body trails off in the *other* direction, so `Oh`'s own
legal next moves all point back toward `F` over the next couple of ticks rather than
away from it — exactly the geometry of a snake retreating from the attack-bonus move
that made this candidate attractive in the first place (§5/`risky`/`prey`).

Candidate move: into `C`. Our tail `T` vacates in 1 tick, same as §4; `safeSpace` walks
`C → M → T (now vacated) → F`, reaching 4 cells plus whatever else is nearby, comfortably
`>= length` once a few more cells elsewhere are counted. Nothing is wrong with that part
— `vacateAt` ages our own tail correctly, and the opponent's current body is correctly
treated as a permanent wall everywhere except its own tail, per the existing (kept, see
§7.5) rule. The gap is `F`: it's a *free* cell right now, so neither model blocks it —
`vacateAt` has nothing to say about a cell no one currently occupies, and the opponent's
*current* body doesn't reach it either. But the opponent's own near-future path does,
in about the same number of ticks our single-file walk needs to get there. `safeSpace`
has no way to know this: it tracks our own tail's vacate schedule and the opponent's
*current* body as a wall, and has no model at all for what a currently-free cell's
future occupant might be. If the opponent's retreat reaches `F` at or before our arrival
tick, our "safe" corridor is blocked from the inside by a wall that didn't exist when we
computed `safeSpace` — and because the path is single-file, there is nothing to divert
to. Same dead-end dynamic as §4, except the wall materializes from a second snake's body
instead of having been there since turn one.

### 7.2 Do snork or battlesnake-rs simulate the opponent's future path? Direct answer

**Not as "predict their one path" — but both do something stronger: flood from every
living snake's head simultaneously, so the opponent's reachable space is modeled exactly
as richly as your own, without ever having to guess which way they'll actually go.**

`wrenger/snork`'s `floodfill.rs` `flood_snakes` (lines 230–253) seeds *every* snake,
not just the acting one, into one shared queue:

```rust
// Longer or equally long snakes first
self.flood(
    grid,
    snakes
        .iter()
        .enumerate()
        .filter(|&(_, s)| s.alive())
        .map(|(id, s)| SnakePos::new(s.head(), id as _, 0, 0, s.body.len() as _, s.health)),
)
```

and `flood()` (line 137) does `queue.extend(heads)` (line 173) — a genuine multi-source
BFS, every snake's frontier (yours *and* the enemy's) expanding one tick at a time from
its own current head, racing for the same cells. `owns()` (line 138) is the per-cell
arbiter when two frontiers meet:

```rust
// Reached in same step?
FCell::Owned { id, health, len, distance } => {
    distance == s_distance
        && if id != s_id {
            // Longer snake wins (on draw we loose)
            len < s_len || len == s_len && id < s_id
        } else {
            // We can reach this with more health
            health < s_health
        }
}
```

So the "enemy model" isn't a predicted path at all — it's the enemy's *entire*
reachable frontier, exactly as uncommitted as yours, contesting every cell by arrival
tick with length/id as the tiebreak. The doc comment on `flood_snakes` (lines 227–229)
confirms the intent: *"the snake at position and id 0 is the evaluated agent and the
other snakes are the enemies"* — plural, same algorithm, no special-casing of "their"
frontier versus "ours" beyond who gets priority in a tie.

`coreyja/battlesnake-rs`'s `spread_from_head_tail_aware.rs` does the identical thing.
`sorted_snake_ids` (line 87) orders *all* snakes "longer snakes first," then (lines
113–117) pushes **every** snake's head as a starting frontier:

```rust
for sid in &sorted_snake_ids {
    let head = self.get_head_as_native_position(sid);
    visited[head.as_usize()] = true;
    todos.push(CellWrapper(head));
    todos_per_snake[sid.as_usize()] += 1;
}
```

and the per-cycle loop (line 132 onward) advances every snake's frontier in the same
pass, claiming each unclaimed, vacated-in-time cell for whichever snake's turn in the
(length-sorted) iteration order reaches it first that cycle.

**So: no, neither bot predicts a single most-likely enemy path (that's what this repo's
own `lookaheadTerritory` does, for a different purpose — see §7.4). Both instead run a
multi-source, time-respecting flood fill where the opponent's future is modeled by
letting their frontier expand freely in every direction, the same as yours, and
resolving collisions by arrival tick.** That is a *better* fit for a safety check than
path prediction would be: it doesn't require correctly guessing the opponent's
direction, only bounding what they could geometrically reach by a given tick — exactly
the conservative property a trap-avoidance gate needs.

A third, independent primary source corroborates the same architecture outside the
Rust-bot community entirely. [Mejia et al., "Albatross"](https://arxiv.org/abs/2402.03136)
(Appendix C.1, "Baseline Agent," read via the [ar5iv HTML
rendering](https://ar5iv.labs.arxiv.org/html/2402.03136) since the arXiv PDF has no
extractable text layer) describes its Battlesnake baseline's area-control heuristic as a
flood fill that "fills the board starting from the heads of **all living snakes**"
(emphasis the mechanism, not a verbatim quote), with — in the stochastic game modes —
each snake's tail "dynamically deleted... in every iteration" to simulate movement
(matching §3's vacate-time mechanism independently), and: *"If two snakes are able to
reach a grid square at the same time, we use the length as a tie break."* Three
independently-written codebases (one academic, two competitive-community) converge on
the same shape: seed every snake's head, expand every frontier together, resolve ties by
length. None of the three use the word "Voronoi" for this (see §7.4).

### 7.3 Where this already exists for a *different* purpose in named competitive bots

Both of the codebases this doc already cites turn out to combine opponent-modeling and
contested-space scoring in instructive, directly-relevant ways — neither uses the
contested flood fill as a hard per-move safety *gate* the way `move.ts` uses `safeSpace`.

**`wrenger/snork`.** `src/agents/flood.rs`'s `FloodHeuristic::eval` calls
`flood_fill.flood_snakes(...)` and turns the *same* multi-source, contested fill from
§7.2 into a continuous score — `count_health(0)` (own contested space) versus
`count_health(i)` for "the longest enemy," combined as a ratio (`space_adv`) — fed in as
one term of a leaf evaluation. That evaluation runs inside `src/agents/maxn.rs`'s
`iterative_tree_search`, an iterative-deepening MaxN search with `const MAX_DEPTH: usize
= 16`. In other words: snork doesn't need a boolean "is this corridor a trap" gate at
all, because it searches up to 16 plies deep and the single-file-corridor trap shows up
*in the score itself* several plies down (the contested-space ratio collapses, or the
branch hits `search::LOSS`) — the opponent's own moves are explored as actual tree
nodes, not predicted. Also found, confirming the user's "Marvin" lead: snork's own
README names its Tree/MaxN agent *"ich heisse marvin"* ("my name is Marvin"), placing
1st–2nd in the global, dual, and royale arenas — this is the same snork repo already
cited in §3, not a separate bot; there is no other public, independently-verified
"Marvin" Battlesnake codebase found in this search.

**`coreyja/battlesnake-rs`.** The repo contains two bots that split opponent-modeling
and contested-space-scoring into independently reusable pieces — exactly the split
`move.ts` currently has (`lookaheadTerritory` vs. `safeSpace`), but wired differently:

- `battlesnake-minimax/src/paranoid/mod.rs` (lines 1–9) implements *Paranoid Minimax*,
  full opponent-move modeling with **no** flood fill at all: *"This variant assumes all
  your opponents are working together to minimize your score... When propagating scores
  up the tree, it chooses the highest score when its your turn and the lowest score when
  its the opponent's turn."* `devious_devin_eval.rs`'s `score()` function, which plugs
  into this engine, scores leaves by distance-to-food / distance-to-opponent-head only
  (`ScoreEndState::ShorterThanOpponent`/`LongerThanOpponent`) — no space/flood-fill term
  anywhere.
- `battlesnake-rs/src/hovering_hobbs.rs` reuses that *same* Paranoid Minimax engine but
  swaps in `standard_score_tail_aware` as the leaf evaluator, which calls
  `node.squares_per_snake_with_scores_tail_aware(...)` — i.e., it plugs the multi-snake,
  tail-aware, contested flood fill from §3/§7.2 in as the position score *inside* a full
  adversarial search, rather than as a per-move boolean gate.

The underlying blog post the `paranoid/mod.rs` doc comment links to,
[coreyja's "Minimax in Battlesnake"](https://coreyja.com/BattlesnakeMinimax/Minimax%20in%20Battlesnake/),
names the two multiplayer minimax variants directly: *"Paranoid Minimax gets its name by
being 'paranoid' and thinking all the opponents are out to get you specifically"* (worst
case, your single score is minimized by the opponent's actual choice among their real
moves), versus *MaxN*, where *"Snakes are doing what's best for themselves, not only
what's bad for you"* (each opponent maximizes its own score, searched as an independent
branch). Both are genuine multi-ply, alternating game-tree searches over the opponent's
*actual* legal moves at each node — not a flood fill at all, and architecturally a much
bigger change than a single extra BFS pass.

[terrarium.coreyja.com](https://terrarium.coreyja.com/)'s bot gallery corroborates the
naming (*"Hovering Hobbs: Advanced paranoid minimax with flood fill scoring,"* *"Jump
Flooding: Minimax with jump flooding algorithm for space evaluation... maximizes the
ratio of squares under its control"*) but is a marketing-style one-line-per-bot gallery
page, not inspectable source — corroborating only, same caveat as this doc's existing
CyberSnake/Devpost citation in §3.

**Honest scoping note:** none of this is directly portable to a 10ms-per-move Cloudflare
Workers budget. Both `MAX_DEPTH = 16` iterative deepening and full Paranoid
Minimax/MaxN assume a server-side time budget far larger than 10ms (standard Battlesnake
timeouts are 500ms+). The reason these bots don't need a corridor-trap heuristic gate is
that they can afford to *search* far enough to see the trap materialize in the score.
`move.ts` cannot afford that search depth, which is exactly why it needs the §7.5 fix
below: a cheap, single-pass proxy for "would a few more plies of real search have caught
this," not a smaller version of minimax itself.

### 7.4 Is there a name for this, and did we reinvent half of it already?

**No single term is used identically across all primary sources found.** The nearest
thing to a standard name is **"area control"** — used by both the terrarium gallery and
the Albatross paper (§7.2) for any flood-fill-derived space score. Critically, **none**
of snork, battlesnake-rs, or the Albatross paper's own baseline call their multi-source,
tie-broken flood fill "Voronoi," despite it being, mechanically, exactly a time- and
obstacle-aware Voronoi partition (each cell assigned to whichever snake's expanding
frontier reaches it first, ties broken by length). Secondary community write-ups (seen
only via search summaries this session, not fetched as primary sources, so not quoted)
do use "Voronoi" — but for a *cruder* cousin that compares straight-line/Manhattan
distance from each head and ignores obstacles entirely, explicitly as an approximation
to the real flood fill. Since no primary source attests one canonical name for the exact
mechanism needed here, this doc uses a plain mechanical description instead of coining
one: a **multi-source, time-respecting flood fill with simultaneous frontiers**
(equivalently: a *contested* or *shared* flood fill).

**Did `move.ts` already reinvent half of it?** Yes — two different halves, in two
different places, neither wired to the safety gate:

- `territoryAfter`'s tie-break —
  `if (mineDist[c] < theirDist[c]) t++; else if (mineDist[c] > theirDist[c]) t--;`
  (`move.ts` lines 116–119) — is structurally the *same arbitration rule* as snork's
  `owns()` "reached in same step" branch and battlesnake-rs's length-sorted claim order:
  whichever BFS reaches a cell first wins it. This is the **multi-source** half.
- `safeSpace`/`vacateAt` (`move.ts` lines 64–96) is the **time-respecting** half: it
  correctly ages our own body's cells by vacate tick, the exact mechanism in §3/§6.

But `territoryAfter` is only ever fed a single *static* snapshot (`distances()`, no
vacate-time awareness for either snake — `blocked2` treats all non-tail body as
permanently blocked), is only reachable through `lookaheadTerritory`'s one *predicted*
opponent move (not a free multi-directional frontier), and only feeds `score[4]` (the
duel tie-break) — never `score[0]` (the safety gate). `safeSpace` is time-respecting but
strictly single-source (only our own frontier ever expands). **Neither half alone, nor
the two as currently wired, gives the safety gate what it needs: a BFS that is both
time-respecting *and* multi-source.** §7.5 combines them for that one purpose,
reusing both pieces already in the file rather than adding a third parallel mechanism.

### 7.5 Concrete fix

Two independent additions to §6's existing `vacateAt`/`safeSpace`, not a replacement for
either. Both are scoped to `duel` (one opponent), exactly as `lookaheadTerritory`
already is, for the same cost reason (§7.6).

**(a) Contested-space discount — the opponent-modeling half, directly reusing the
pattern from §7.2/§7.3.** Run one extra vacate-respecting BFS per `chooseMove` call,
seeded at the opponent's *current* head (not a predicted move), using a mirrored vacate
table (their body ages for real, ours is `NEVER` beyond our own tail — the same rule
`vacateAt` already applies, with the roles swapped):

```ts
// Same shape as vacateAt, but from the opponent's point of view: their body gets its
// real per-segment vacate tick; ours only counts our tail as free, mirroring the rule
// vacateAt already applies to them. Duel only.
function vacateAtFor(ownerId: string): Uint16Array {
  const v = new Uint16Array(width * height);
  for (const s of board.snakes) {
    const n = s.body.length;
    const owner = s.id === ownerId;
    for (let i = 0; i < n; i++) {
      const k = key(s.body[i].x, s.body[i].y);
      const ticks = owner || i === n - 1 ? n - i : NEVER;
      if (ticks > v[k]) v[k] = ticks;
    }
  }
  return v;
}

// How soon the opponent could plausibly occupy each cell, moving every tick from their
// CURRENT head in every direction at once (no path guess — same multi-directional
// frontier idea as snork's flood_snakes / battlesnake-rs's multi-head seeding, just
// single-source here because there's only one opponent to bound against). Capped at our
// own body length: safeSpace never needs to know about anything further out than that.
function opponentTick(opponent: Snake): Int16Array {
  const oppVacate = vacateAtFor(opponent.id);
  const tick = new Int16Array(width * height).fill(-1);
  const startK = key(opponent.head.x, opponent.head.y);
  tick[startK] = 0;
  const queue = [startK];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i], t = tick[k];
    if (t >= you.length) continue;
    const cx = k % width, cy = (k / width) | 0;
    for (const [, dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy, nk = key(nx, ny);
      if (inBounds(nx, ny) && tick[nk] === -1 && t + 1 >= oppVacate[nk]) {
        tick[nk] = t + 1;
        queue.push(nk);
      }
    }
  }
  return tick;
}
```

A cell only counts toward our own `safeSpace` if we are *strictly* first — a tie is not
good enough, because the opponent's body still physically occupies or sweeps through
that cell at the tick we need it, even if a territory-style tie-break would have
assigned it to us on length:

```ts
// Inside safeSpace's existing BFS (§6), when testing a neighbor k at tick+1:
if (inBounds(nx, ny) && !seen.has(k) && tick + 1 >= vacateAt[k]) {
  if (duel && oppTick[k] !== -1 && oppTick[k] <= tick + 1) continue; // contested: skip it
  seen.add(k);
  queue.push([nx, ny, tick + 1]);
}
```

**(b) Zero-slack-corridor penalty — independent of the opponent, this doc's own
reasoned addition.** None of §7.2's or §7.3's sources treat *branching factor* as a
risk factor separate from raw reachable-cell count — this part is not attributed to any
of them. The turn-61 counterexample shows a path can satisfy `count >= length` while
offering no slack at all: once committed, there is exactly one legal next cell for
several consecutive ticks, so any single wrong assumption anywhere in the model (an
opponent's move, a food pickup along the way, an off-by-one in the vacate math) is fatal
with no chance to react. That is a real risk independent of whether the opponent happens
to contest a specific cell this time, and it is worth scoring for its own sake. Track,
during the same BFS, whether the swept region ever had a real branch point before the
bare minimum was met, and if not, require a small safety margin instead of trusting the
count flat:

```ts
const CORRIDOR_MARGIN = 2; // shortcut: a flat constant, not tuned - see note below

// safeSpace, extended to return both the count and whether a branch point was seen:
function safeSpace(x: number, y: number): { count: number; sawBranch: boolean } {
  const seen = new Set([key(x, y)]);
  const queue: [number, number, number][] = [[x, y, 1]];
  let count = 0, sawBranch = false;
  for (let i = 0; i < queue.length; i++) {
    const [cx, cy, tick] = queue[i];
    count++;
    let branches = 0;
    for (const [, dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy, k = key(nx, ny);
      if (!inBounds(nx, ny) || seen.has(k) || tick + 1 < vacateAt[k]) continue;
      if (duel && oppTick[k] !== -1 && oppTick[k] <= tick + 1) continue;
      branches++;
      seen.add(k);
      queue.push([nx, ny, tick + 1]);
    }
    if (branches >= 2) sawBranch = true;
    // Stop once either a generous margin is already banked, or a real choice point
    // has been confirmed and the bare minimum is met - whichever is cheaper to reach.
    if (count >= you.length + CORRIDOR_MARGIN || (sawBranch && count >= you.length)) {
      return { count, sawBranch };
    }
  }
  return { count, sawBranch };
}

// Per candidate move, replacing §6's `safeSpace(x, y) >= you.length`:
const { count, sawBranch } = safeSpace(x, y);
const safe = count >= you.length && (sawBranch || count >= you.length + CORRIDOR_MARGIN);
```

```
shortcut: CORRIDOR_MARGIN is a flat constant (2), not tuned against real games. Upgrade
by A/B-testing a couple of values, or by scaling it with `you.length` (a longer snake
plausibly needs more slack per the same logic), if the flat constant is ever shown to
misfire either direction.
```

This is a strict superset of §6, not a parallel system: when there is no opponent
(`duel` is false) or the swept region has an early branch point and plenty of count, it
degenerates to exactly today's `count >= you.length`.

### 7.6 Complexity / ~10ms budget

Same conclusion as §6.1, for the same reason: this adds one more same-size BFS, not a
combinatorial search, because a duel has exactly one opponent to bound against (matching
the brief precisely — "the opponent's flood fill is one extra same-size BFS, not
combinatorial").

- `vacateAtFor(opponent.id)`: one extra O(total snake length) pass (well under 100
  segments on an 11x11 board), once per `chooseMove` call, duel only.
- `opponentTick`: one extra BFS capped at `you.length` ticks deep, so at most
  `width * height` = 121 cells visited (fewer in practice, since it stops expanding past
  our own horizon), once per `chooseMove` call, duel only — not once per candidate
  direction.
- Per candidate direction (up to 4 in `chooseMove`'s existing loop): `safeSpace` now
  scans up to `you.length + CORRIDOR_MARGIN` cells instead of `you.length` (a few more
  cells, bounded by a small constant), with one extra O(1) array lookup (`oppTick[k]`)
  and one extra tiny branch-count per cell already being visited — no new pass over the
  board, just a few more comparisons folded into the loop §6 already runs.

Total added cost per `chooseMove` call in a duel: one extra ≤121-cell BFS plus a few
hundred extra integer comparisons spread across the up-to-4 existing `safeSpace` calls —
the same order of magnitude §6.1 already concluded was negligible against a budget that
already runs a dozen+ BFS passes per move. No new search depth, no backtracking, and
(by design, per the brief) no per-opponent blowup: a 3+-snake Standard game would need
this contested check against every opponent to be sound, which is why — like
`lookaheadTerritory` already does — this stays scoped to `duel` rather than generalizing
unscoped to Standard play.

### 7.7 Direct answers

**Is there a known name for this technique?** No single term is attested identically
across the primary sources found. "Area control" is the closest to a standard
community/academic label for the general family (flood-fill-derived space scoring); the
specific multi-source, time-respecting, tie-broken-by-length mechanism that snork,
battlesnake-rs, and the Albatross paper's baseline all independently converge on has no
single name in any of those three sources — none of them call it "Voronoi," though
that's the most accurate plain-English description of what it mechanically does.

**Did we essentially reinvent half of it already?** Yes, two different halves, in two
different places, as detailed in §7.4: `territoryAfter`'s tie-break is the
**multi-source** half (same arbitration rule as snork's `owns()`); `safeSpace`/`vacateAt`
is the **time-respecting** half. Neither is currently wired to the safety gate, and
neither alone is sufficient for it — §7.5 combines them for that specific purpose,
without replacing either existing use.

## Sources

- [docs.battlesnake.com/guides/useful-algorithms](https://docs.battlesnake.com/guides/useful-algorithms) — official flood fill / A* guide (static flood fill only, no Voronoi/traps page exists on the official site)
- [github.com/BattlesnakeOfficial/rules](https://github.com/BattlesnakeOfficial/rules) — rules engine source
  - [`standard.go`](https://github.com/BattlesnakeOfficial/rules/blob/main/standard.go) — `MoveSnakesStandard`, `growSnake`/`FeedSnakesStandard`, `EliminateSnakesStandard`, `snakeIsOutOfBounds`, `snakeIsOutOfHealth`, `snakeHasBodyCollided`, `snakeHasLostHeadToHead`, `standardRulesetStages`
  - [`pipeline.go`](https://github.com/BattlesnakeOfficial/rules/blob/main/pipeline.go) — stage ordering contract (`NewPipelineFromRegistry`)
- [github.com/wrenger/snork](https://github.com/wrenger/snork) — [`src/floodfill.rs`](https://github.com/wrenger/snork/blob/main/src/floodfill.rs): `FCell::Occupied{id, tail_dist}`, `owns()`, time-aware flood fill; [`src/agents/flood.rs`](https://github.com/wrenger/snork/blob/main/src/agents/flood.rs): `FloodHeuristic` leaf scoring; [`src/agents/maxn.rs`](https://github.com/wrenger/snork/blob/main/src/agents/maxn.rs): iterative-deepening MaxN, `MAX_DEPTH = 16`; README: `Tree`/MaxN agent nicknamed "marvin," Leibniz University Hannover AI games course
- [github.com/coreyja/battlesnake-rs](https://github.com/coreyja/battlesnake-rs) — [`battlesnake-rs/src/flood_fill/spread_from_head_tail_aware.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-rs/src/flood_fill/spread_from_head_tail_aware.rs): `body_life`/"enterable cycle", stacked-tail and growth-approximation comments, multi-head seeding; [`battlesnake-minimax/src/paranoid/mod.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-minimax/src/paranoid/mod.rs): Paranoid Minimax; [`battlesnake-rs/src/devious_devin_eval.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-rs/src/devious_devin_eval.rs): minimax without flood fill; [`battlesnake-rs/src/hovering_hobbs.rs`](https://github.com/coreyja/battlesnake-rs/blob/main/battlesnake-rs/src/hovering_hobbs.rs): tail-aware flood fill as a Paranoid Minimax leaf eval
- [coreyja.com/BattlesnakeMinimax/Minimax in Battlesnake](https://coreyja.com/BattlesnakeMinimax/Minimax%20in%20Battlesnake/) — Paranoid Minimax vs. MaxN explained by the `battlesnake-minimax` crate's own author
- [terrarium.coreyja.com](https://terrarium.coreyja.com/) — bot gallery corroborating Paranoid Minimax/MaxN/Jump-Flooding naming (marketing-style page, not inspectable source, corroborating only)
- [arxiv.org/abs/2402.03136](https://arxiv.org/abs/2402.03136) (Mejia et al., "Albatross"), Appendix C.1 "Baseline Agent," read via the [ar5iv HTML rendering](https://ar5iv.labs.arxiv.org/html/2402.03136) — independent academic confirmation of multi-source, tail-removing flood fill with length tie-break, for the Battlesnake baseline agent specifically
- [devpost.com/software/cybersnake](https://devpost.com/software/cybersnake) — author's own description of a "time-aware flood fill" treating the tail as temporarily passable (corroborating, seen via search snippet only — direct fetch returned HTTP 403, so not quoted as a code source)
