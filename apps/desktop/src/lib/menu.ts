/**
 * The next row of a list moved through with the arrow keys.
 *
 * `current` is -1 while nothing is chosen, and a position past a list that has since shrunk counts as
 * that too: down then starts at the first row and up at the last. Moving wraps at both ends.
 */
export function cycle(current: number, delta: 1 | -1, count: number): number {
	if (count <= 0) return -1;
	if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
	return (current + delta + count) % count;
}
