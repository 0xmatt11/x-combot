/**
 * Catalog of planned group games. `!games` prints this even when a command
 * is not registered yet, so other slices can land without rewriting the menu.
 */

export type GameCatalogEntry = {
  command: string;
  blurb: string;
};

export type GameCatalogGroup = {
  title: string;
  games: GameCatalogEntry[];
};

export const GAME_CATALOG: readonly GameCatalogGroup[] = [
  {
    title: "Instant",
    games: [
      { command: "!dice", blurb: "roll dice" },
      { command: "!rps", blurb: "rock-paper-scissors" },
      { command: "!coinflip", blurb: "heads or tails" },
      { command: "!8ball", blurb: "magic 8-ball" },
    ],
  },
  {
    title: "Multiplayer (coming)",
    games: [
      { command: "!tictactoe", blurb: "tic-tac-toe" },
      { command: "!connect4", blurb: "connect four" },
      { command: "!duel", blurb: "duel" },
      { command: "!hangman", blurb: "hangman" },
      { command: "!story", blurb: "story" },
    ],
  },
  {
    title: "Word/solo (coming)",
    games: [
      { command: "!wordle", blurb: "wordle" },
      { command: "!anagram", blurb: "anagram" },
      { command: "!scramble", blurb: "scramble" },
      { command: "!guess", blurb: "guess" },
      { command: "!higherlower", blurb: "higher or lower" },
      { command: "!wouldyourather", blurb: "would you rather" },
      { command: "!truthordare", blurb: "truth or dare" },
    ],
  },
  {
    title: "XP/casino (coming)",
    games: [
      { command: "!slots", blurb: "slots" },
      { command: "!blackjack", blurb: "blackjack" },
      { command: "!poker", blurb: "poker" },
      { command: "!roulette", blurb: "roulette" },
      { command: "!crash", blurb: "crash" },
      { command: "!trivia", blurb: "trivia" },
    ],
  },
  {
    title: "Board",
    games: [{ command: "!minesweeper", blurb: "minesweeper (coming)" }],
  },
];

/** Grouped catalog. One short line per game. */
export function gamesMenu(): string {
  const lines: string[] = ["Games:"];
  for (const group of GAME_CATALOG) {
    lines.push(`${group.title}:`);
    for (const game of group.games) {
      lines.push(`${game.command} — ${game.blurb}`);
    }
  }
  return lines.join("\n");
}
